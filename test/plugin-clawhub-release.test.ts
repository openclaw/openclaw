import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { gzipSync } from "node:zlib";
import { Header } from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOpenClawReleaseClawHubPlan,
  parseOpenClawReleaseClawHubPlanArgs,
} from "../scripts/lib/openclaw-release-clawhub-plan.ts";
import {
  collectPluginClawHubReleasePathsFromGitRange,
  collectPluginClawHubReleasePlan,
  resolveOpenClawClawHubPackageFamily,
} from "../scripts/lib/plugin-clawhub-release.ts";
import { writePublishablePluginFixture } from "./helpers/publishable-plugin-fixture.js";
import { cleanupTempDirs, makeTempDir as makeTempRepoRoot } from "./helpers/temp-dir.js";

const tempDirs: string[] = [];
const trustedPublisher = {
  repository: "openclaw/openclaw",
  workflowFilename: "plugin-clawhub-release.yml",
};
const fixturePackageName = "@openclaw/demo-plugin";
const registryBaseUrl = "https://clawhub.ai";
const packagePath = "/api/v1/packages/%40openclaw%2Fdemo-plugin";
const publishedPackage = { status: 200, body: { trustedPublisher } };

function availablePackageFetch(override: (pathname: string) => Response | undefined) {
  const { fetchImpl } = createClawHubPlanFetch({
    packages: { [fixturePackageName]: { status: 200 } },
    trustedPublishers: { [fixturePackageName]: publishedPackage },
    versions: { [`${fixturePackageName}@2026.4.1`]: 404 },
  });
  const wrapped: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return override(new URL(url).pathname) ?? fetchImpl(input, init);
  };
  return wrapped;
}

function planOptions(rootDir: string, fetchImpl: typeof fetch) {
  return { rootDir, fetchImpl, selection: [fixturePackageName], registryBaseUrl };
}

function publicationFixture(publication: Record<string, unknown>, exists = true) {
  const name = fixturePackageName;
  const version = "2026.4.1";
  const { fetchImpl, requests } = createClawHubPlanFetch({
    packages: { [name]: { status: exists ? 200 : 404 } },
    trustedPublishers: exists ? { [name]: publishedPackage } : undefined,
    publications: {
      [`${name}@${version}`]: { status: 200, body: { name, version, ...publication } },
    },
    // A legacy probe would wrongly turn pending/failed into a publish candidate.
    versions: { [`${name}@${version}`]: 404 },
  });
  return { options: { rootDir: createTempPluginRepo(), fetchImpl }, requests };
}

function publishEnv(repoDir: string, env: NodeJS.ProcessEnv = {}) {
  return {
    ...process.env,
    PATH: `${join(repoDir, "bin")}${delimiter}${process.env.PATH ?? ""}`,
    ...env,
  };
}
function publishOptions(cwd: string, env: NodeJS.ProcessEnv = {}) {
  return { cwd, encoding: "utf8" as const, env: publishEnv(cwd, env) };
}

function artifactFixture(filename: string, duplicateNormalizedPackageJson = false) {
  const repoDir = createTempPluginRepo();
  const binDir = join(repoDir, "bin");
  const markerPath = join(repoDir, "clawhub-invoked");
  const tgzPath = join(repoDir, filename);
  const tgzBytes = createClawPackBytes(duplicateNormalizedPackageJson);
  mkdirSync(binDir, { recursive: true });
  writeFileSync(tgzPath, tgzBytes);
  const env = {
    EXPECTED_CLAWHUB_ARTIFACT_SHA256: createHash("sha256").update(tgzBytes).digest("hex"),
    EXPECTED_CLAWHUB_ARTIFACT_SIZE: String(tgzBytes.byteLength),
    EXPECTED_CLAWHUB_PACKAGE_NAME: fixturePackageName,
    EXPECTED_CLAWHUB_PACKAGE_VERSION: "2026.4.1",
    PACKAGE_DIR: "extensions/demo-plugin",
  };
  return { repoDir, binDir, markerPath, tgzPath, env };
}
const publishScript = join(process.cwd(), "scripts/plugin-clawhub-publish.sh");
function publishArgs(mode: string, target = "extensions/demo-plugin") {
  return [publishScript, mode, target];
}

afterEach(() => cleanupTempDirs(tempDirs));

function createClawPackBytes(duplicate: boolean) {
  function entry(name: string, contents: string) {
    const bytes = Buffer.from(contents);
    const header = Buffer.alloc(512);
    new Header({
      path: name,
      type: "File",
      mode: 0o644,
      uid: 0,
      gid: 0,
      size: bytes.byteLength,
      mtime: new Date(0),
    }).encode(header);
    const padding = Buffer.alloc((512 - (bytes.byteLength % 512)) % 512);
    return Buffer.concat([header, bytes, padding]);
  }

  const packageJson = JSON.stringify({
    name: fixturePackageName,
    version: "2026.4.1",
    openclaw: { release: { publishToClawHub: true } },
  });
  const packageJsonEntries = duplicate
    ? [entry("package/package.json", packageJson), entry("package/package.json", packageJson)]
    : [entry("package/package.json", packageJson)];
  return gzipSync(
    Buffer.concat([
      ...packageJsonEntries,
      entry("package/openclaw.plugin.json", JSON.stringify({ id: "demo-plugin" })),
      Buffer.alloc(1024),
    ]),
  );
}

describe("collectPluginClawHubReleasePlan", () => {
  it("preserves legacy bundle families for established ClawHub package names", () => {
    expect(resolveOpenClawClawHubPackageFamily("@openclaw/cloudflare")).toBe("bundle-plugin");
    expect(resolveOpenClawClawHubPackageFamily("@openclaw/demo-plugin")).toBe("");
  });

  it.each([
    { state: "pending", stage: "checks", attemptId: "jd7abc_123-xyz" },
    { state: "failed", recoverable: true, attemptId: "jd7abc_123-xyz" },
  ])(
    "plans publication detail without republishing $state/$stage/$recoverable",
    async (publication) => {
      const { options, requests } = publicationFixture(publication);
      const plan = await collectPluginClawHubReleasePlan(options);
      for (const [bucket, state] of [
        ["candidates", "absent"],
        ["skippedPublished", "published"],
        ["pendingPublication", "pending"],
        ["failedPublication", "failed"],
      ] as const) {
        expect(plan[bucket]).toEqual(publication.state === state ? plan.all : []);
      }
      expect(plan.all[0]).toMatchObject({
        publication,
        alreadyPublished: publication.state === "published",
      });
      expect(requests.filter((url) => url.includes("/versions/"))).toEqual([
        `${packagePath}/versions/2026.4.1/publication`,
      ]);
    },
  );

  it("does not bootstrap a pending package shell hidden by the metadata route", async () => {
    const publication = { state: "pending", stage: "staging" };
    const { options } = publicationFixture(publication, false);
    const plan = await collectPluginClawHubReleasePlan(options);
    expect(plan).toMatchObject({
      candidates: [],
      bootstrapCandidates: [],
      missingTrustedPublisher: [],
    });
    expect([...plan.pendingPublication, ...plan.failedPublication]).toEqual(plan.all);
    expect(plan.all[0]?.publication).toEqual(publication);
  });

  it.each([
    { state: "future" },
    { state: "published", name: "@openclaw/wrong" },
    { state: "failed", recoverable: true, attemptId: "bad\ncommand" },
  ])("fails closed on invalid publication detail %j", async (publication) => {
    const { options, requests } = publicationFixture(publication);
    await expect(collectPluginClawHubReleasePlan(options)).rejects.toThrow(
      "Invalid ClawHub publication state",
    );
    expect(requests.some((url) => url.endsWith("/versions/2026.4.1"))).toBe(false);
  });

  it("bounds parallel ClawHub package-state reads and preserves plan order", async () => {
    const extraExtensionIds = Array.from({ length: 11 }, (_, index) => `demo-${index + 2}`);
    const repoDir = createTempPluginRepo({ extraExtensionIds });
    const packageNames = ["demo-plugin", ...extraExtensionIds].map(
      (extensionId) => `@openclaw/${extensionId}`,
    );
    const baseFetch = createClawHubPlanFetch({
      packages: Object.fromEntries(packageNames.map((name) => [name, { status: 200 }])),
      trustedPublishers: Object.fromEntries(packageNames.map((name) => [name, publishedPackage])),
      versions: Object.fromEntries(
        packageNames.map((packageName) => [`${packageName}@2026.4.1`, 404]),
      ),
    }).fetchImpl;
    let activeRequests = 0;
    let maxActiveRequests = 0;
    let releaseFirstWave: () => void;
    const firstWave = new Promise<void>((resolve) => {
      releaseFirstWave = resolve;
    });
    const fetchImpl: typeof fetch = async (...args) => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      try {
        if (activeRequests === 8) {
          releaseFirstWave();
        }
        await firstWave;
        return await baseFetch(...args);
      } finally {
        activeRequests -= 1;
      }
    };

    const plan = await collectPluginClawHubReleasePlan({
      rootDir: repoDir,
      selectionMode: "all-publishable",
      fetchImpl,
      registryBaseUrl: "https://clawhub.ai",
    });

    expect(maxActiveRequests).toBe(8);
    expect(plan.all.map((plugin) => plugin.packageName)).toEqual(packageNames.toSorted());
    expect(plan.candidates.map((plugin) => plugin.packageName)).toEqual(packageNames.toSorted());
  });

  it("retries a transient transport failure during version lookup", async () => {
    const repoDir = createTempPluginRepo();
    let versionRequests = 0;
    const retryDelays: number[] = [];
    const fetchImpl = availablePackageFetch((pathname) => {
      if (pathname === `${packagePath}/versions/2026.4.1`) {
        versionRequests += 1;
        if (versionRequests === 1) {
          throw new TypeError("fetch failed");
        }
        return new Response("", { status: 404 });
      }
      return undefined;
    });

    const plan = await collectPluginClawHubReleasePlan({
      ...planOptions(repoDir, fetchImpl),
      sleep: async (ms) => {
        retryDelays.push(ms);
      },
    });

    expect(versionRequests).toBe(2);
    expect(retryDelays).toEqual([1_000]);
    expect(plan.candidates.map((plugin) => plugin.packageName)).toEqual(["@openclaw/demo-plugin"]);
  });

  it.each([
    [
      "response details",
      "Rate limit temporarily unavailable",
      { "Retry-After": "1", "x-request-id": "request-123" },
      "Rate limit temporarily unavailable [retry-after=1; x-request-id=request-123]",
    ],
    [
      "UTF-16-safe truncation",
      `${"x".repeat(398)}\u{1f600}tail`,
      undefined,
      `${"x".repeat(398)}\u{1f600}...`,
    ],
  ] as const)(
    "preserves %s after package retries are exhausted",
    async (_name, body, headers, detail) => {
      let packageRequests = 0;
      const fetchImpl: typeof fetch = async () => {
        packageRequests += 1;
        return new Response(body, { status: 503, headers });
      };
      await expect(
        collectPluginClawHubReleasePlan({
          ...planOptions(createTempPluginRepo(), fetchImpl),
          sleep: async () => {},
        }),
      ).rejects.toThrow(`Failed to query ClawHub package @openclaw/demo-plugin: 503 ${detail}`);
      expect(packageRequests).toBe(4);
    },
  );

  it("reports an excessive Retry-After without retrying before the server permits", async () => {
    const repoDir = createTempPluginRepo();
    let trustedPublisherRequests = 0;
    const retryDelays: number[] = [];
    const fetchImpl = availablePackageFetch((pathname) => {
      if (pathname === `${packagePath}/trusted-publisher`) {
        trustedPublisherRequests += 1;
        if (trustedPublisherRequests === 1) {
          return new Response("", { status: 429, headers: { "retry-after": "999999999999" } });
        }
      }
      return undefined;
    });

    await expect(
      collectPluginClawHubReleasePlan({
        ...planOptions(repoDir, fetchImpl),
        sleep: async (ms) => {
          retryDelays.push(ms);
        },
      }),
    ).rejects.toThrow("429 HTTP 429 [retry-after=999999999999]");

    expect(trustedPublisherRequests).toBe(1);
    expect(retryDelays).toEqual([]);
  });

  it("keeps ClawHub trusted publisher timeouts active while reading response bodies", async () => {
    const repoDir = createTempPluginRepo();
    const fetchImpl = availablePackageFetch((pathname) => {
      if (pathname === `${packagePath}/trusted-publisher`) {
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
      }
      if (pathname === packagePath) {
        return undefined;
      }
      throw new Error(`Unexpected ClawHub request to ${pathname}`);
    });

    await expect(
      collectPluginClawHubReleasePlan({
        ...planOptions(repoDir, fetchImpl),
        requestTimeoutMs: 5,
      }),
    ).rejects.toThrow("ClawHub request timed out after 5ms");
  });

  it("routes environment-pinned trusted publisher config out of normal candidates", async () => {
    const repoDir = createTempPluginRepo();
    const fetchImpl = availablePackageFetch((pathname) => {
      if (pathname !== `${packagePath}/trusted-publisher`) {
        return undefined;
      }
      return Response.json({
        trustedPublisher: { ...trustedPublisher, environment: "clawhub-plugin-release" },
      });
    });
    const plan = await collectPluginClawHubReleasePlan(planOptions(repoDir, fetchImpl));
    expect([plan.candidates, plan.bootstrapCandidates]).toStrictEqual([[], []]);
    expect(plan.missingTrustedPublisher.map((plugin) => plugin.packageName)).toEqual([
      "@openclaw/demo-plugin",
    ]);
  });
});

describe("buildOpenClawReleaseClawHubPlan", () => {
  it("emits a dispatch plan that keeps release bytes separate from protected tooling", async () => {
    const repoDir = createTempPluginRepo({
      extraExtensionIds: ["demo-two", "demo-three"],
      requiredLatestDependencyVersion: "1.2.3",
    });
    const { fetchImpl } = createClawHubPlanFetch({
      packages: {
        "@openclaw/demo-plugin": { status: 200, body: { package: {}, owner: {} } },
        "@openclaw/demo-two": { status: 404 },
        "@openclaw/demo-three": { status: 200, body: { package: {}, owner: {} } },
      },
      trustedPublishers: {
        "@openclaw/demo-plugin": publishedPackage,
        "@openclaw/demo-three": { status: 200, body: { trustedPublisher: null } },
      },
      versions: {
        "@openclaw/demo-plugin@2026.4.1": 404,
        "@openclaw/demo-three@2026.4.1": 404,
      },
    });

    const resolveLatestVersion = vi.fn(() => "1.2.4");
    const plan = await buildOpenClawReleaseClawHubPlan(
      {
        bootstrapWorkflowRef: `release-publish/${"d".repeat(12)}-12345`,
        bootstrapWorkflowSha: "d".repeat(40),
        releaseTag: "v2026.4.1-beta.1",
        releaseSha: "a".repeat(40),
        releasePublishBranch: "main",
        releasePublishFullRef: "refs/heads/main",
        releasePublishRunAttempt: "2",
        releasePublishRunId: "12345",
        pluginPublishScope: "all-publishable",
        plugins: [],
      },
      {
        rootDir: repoDir,
        fetchImpl,
        registryBaseUrl: "https://clawhub.ai",
        resolveLatestVersion,
      },
    );

    expect(resolveLatestVersion).toHaveBeenCalledWith("demo-runtime");
    expect(plan.warnings).toEqual(
      ["demo-plugin", "demo-three", "demo-two"].map(
        (id) =>
          `@openclaw/${id}@2026.4.1: demo-runtime pinned "1.2.3", npm latest is "1.2.4". Freshness is advisory; retain the release-validated pin.`,
      ),
    );
    expect(plan).toMatchObject({
      clawHubWorkflowRef: `release-publish/${"d".repeat(12)}-12345`,
      bootstrapWorkflowSha: "d".repeat(40),
      releasePublishBranch: "main",
    });
    const releaseInputs = {
      ref: "a".repeat(40),
      release_tag: "v2026.4.1-beta.1",
      release_publish_run_attempt: "2",
      release_publish_run_id: "12345",
      release_publish_branch: "main",
    };
    const dispatch = { ref: `release-publish/${"d".repeat(12)}-12345`, shouldDispatch: true };
    expect(plan.normal).toEqual({
      ...dispatch,
      workflow: "plugin-clawhub-release.yml",
      packages: ["@openclaw/demo-plugin"],
      inputs: {
        ...releaseInputs,
        publish_scope: "selected",
        plugins: "@openclaw/demo-plugin",
        release_publish_full_ref: "refs/heads/main",
        release_publish_workflow_sha: "d".repeat(40),
      },
    });
    expect(plan.bootstrap).toEqual({
      ...dispatch,
      workflow: "plugin-clawhub-new.yml",
      packages: ["@openclaw/demo-two", "@openclaw/demo-three"],
      inputs: {
        ...releaseInputs,
        bootstrap_workflow_sha: "d".repeat(40),
        plugins: "@openclaw/demo-two,@openclaw/demo-three",
      },
    });
    expect(new Set([...plan.normal.packages, ...plan.bootstrap.packages]).size).toBe(3);
    expect(plan.summary).toEqual({
      normalCount: 1,
      bootstrapCount: 2,
      missingTrustedPublisherCount: 1,
      normalPlugins: "@openclaw/demo-plugin",
      bootstrapPlugins: "@openclaw/demo-two,@openclaw/demo-three",
      missingTrustedPlugins: "@openclaw/demo-three",
    });
    expect(plan.verifier).toEqual({
      clawHubWorkflowRef: `release-publish/${"d".repeat(12)}-12345`,
    });
  });

  it.each([
    ["release-sha", "ABCDEF", "a full 40-character lowercase commit SHA", "release/2026.4.1"],
    ["release-publish-run-attempt", "0", "a positive integer", "main"],
  ])(
    "requires a valid --%s for bootstrap approval binding",
    (flag, invalid, requirement, branch) => {
      const args = Object.entries({
        "bootstrap-workflow-ref": `release-publish/${"d".repeat(12)}-12345`,
        "bootstrap-workflow-sha": "d".repeat(40),
        "release-tag": "v2026.4.1-beta.1",
        "release-sha": "c".repeat(40),
        "release-publish-branch": branch,
        "release-publish-full-ref": "refs/heads/main",
        "release-publish-run-attempt": "1",
        "release-publish-run-id": "12345",
      })
        .filter(([name]) => name !== flag)
        .flatMap(([name, value]) => [`--${name}`, value]);
      expect(() => parseOpenClawReleaseClawHubPlanArgs(args)).toThrow(`--${flag} is required.`);
      expect(() => parseOpenClawReleaseClawHubPlanArgs([...args, `--${flag}`, invalid])).toThrow(
        `--${flag} must be ${requirement}.`,
      );
    },
  );
});

describe("plugin-clawhub-publish.sh", () => {
  it.each(["--dry-run", "--pack"])(
    "runs %s without publishing and preserves its output contract",
    (mode) => {
      const repoDir = createTempPluginRepo();
      const binDir = join(repoDir, "bin");
      const markerPath = join(repoDir, "clawhub-invoked");
      const outputDir = join(repoDir, "clawhub-artifacts");
      writeClawHubPackStub(binDir, markerPath);
      // Release jobs run trusted tooling from an older candidate; its tsconfig
      // paths must not redirect tooling workspace imports to candidate source.
      writeFileSync(join(repoDir, "stale-record-coerce.ts"), "export {};\n");
      writeFileSync(
        join(repoDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            paths: {
              "@openclaw/normalization-core/record-coerce": ["./stale-record-coerce.ts"],
            },
          },
        }),
      );
      const output = execFileSync(
        "bash",
        publishArgs(mode),
        publishOptions(
          repoDir,
          mode === "--dry-run"
            ? { OPENCLAW_CLAWHUB_PACKAGE_FAMILY: "bundle-plugin" }
            : { OPENCLAW_CLAWHUB_PACK_OUTPUT_DIR: outputDir },
        ),
      );
      const invocations = readFileSync(markerPath, "utf8");
      if (mode === "--dry-run") {
        expect(invocations).toContain("--family bundle-plugin");
      } else {
        expect(output).toContain("Packed ClawPack:");
        expect(existsSync(join(outputDir, "openclaw-demo-plugin-2026.4.1.tgz"))).toBe(true);
        expect(invocations).toContain("package pack ");
        expect(invocations).not.toContain("package publish ");
      }
    },
  );

  it("prefers GNU timeout and keeps a portable bounded fallback", () => {
    const source = readFileSync("scripts/plugin-clawhub-publish.sh", "utf8");
    const packExitIndex = source.indexOf('if [[ "${mode}" == "--pack" ]]');
    const timeoutProbeIndex = source.indexOf("for timeout_candidate in timeout gtimeout");

    expect(timeoutProbeIndex).toBeGreaterThan(packExitIndex);
    expect(source).toContain("--signal=TERM --kill-after=1s 1s true");
    expect(source).toContain('"${repo_root}/scripts/lib/bounded-command.mjs"');
    expect(readFileSync("scripts/lib/bounded-command.mts", "utf8")).toContain(
      "timeoutKillGraceMs: 10_000",
    );
    expect(readFileSync("scripts/lib/bounded-command.mjs", "utf8")).toContain(
      "forceKillDelayMs: 15_000",
    );
  });

  it.each(["./clawhub"])("rejects relative ClawHub CLI override %s", (cli) => {
    const repoDir = createTempPluginRepo();
    writeFileSync(join(repoDir, "clawhub"), "#!/bin/sh\nexit 97\n", { mode: 0o755 });
    const result = spawnSync("bash", publishArgs("--pack"), {
      cwd: repoDir,
      encoding: "utf8",
      env: { ...process.env, OPENCLAW_CLAWHUB_CLI: cli },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("OPENCLAW_CLAWHUB_CLI must be an absolute executable path");
  });

  it("rejects duplicate normalized paths before invoking the ClawHub CLI", () => {
    const { repoDir, binDir, markerPath, tgzPath, env } = artifactFixture("ambiguous.tgz", true);
    writeFileSync(
      join(binDir, "clawhub"),
      `#!/usr/bin/env bash
set -euo pipefail
touch ${JSON.stringify(markerPath)}
exit 99
`,
    );
    chmodSync(join(binDir, "clawhub"), 0o755);

    expect(() =>
      execFileSync("bash", publishArgs("--validate-packed", tgzPath), publishOptions(repoDir, env)),
    ).toThrow("Duplicate or aliased plugin tar entry: package/package.json");
    expect(existsSync(markerPath)).toBe(false);
  });

  it.each([
    [
      "CLI Retry-After",
      "Rate limit exceeded (retry in 125s, remaining: 0/10, reset in 125s)",
      [125],
      2,
      false,
      false,
    ],
    ["unbound source", "HTTP 503", [], 1, true, false],
    ["changed artifact", "HTTP 503", [60], 1, false, true],
  ] as const)(
    "handles %s without unsafe replay",
    (_name, error, sleeps, attempts, sourceMode, mutate) => {
      const { repoDir, binDir, markerPath, tgzPath, env } = artifactFixture("immutable.tgz");
      if (sourceMode) {
        const runtimeDir = join(repoDir, "extensions/demo-plugin/dist");
        mkdirSync(runtimeDir, { recursive: true });
        writeFileSync(join(runtimeDir, "index.js"), "export {};\n");
      }
      const attemptsPath = join(repoDir, "publish-attempts");
      const sleepsPath = join(repoDir, "sleeps");
      writeFileSync(sleepsPath, "");
      writeFileSync(
        join(binDir, "sleep"),
        `#!/usr/bin/env bash
printf '%s\\n' "$1" >> "$TEST_SLEEPS"
`,
      );
      chmodSync(join(binDir, "sleep"), 0o755);
      writeFileSync(
        join(binDir, "clawhub"),
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$TEST_INVOCATIONS"
if [[ "\${1:-}" == "--workdir" ]]; then shift 2; fi
if [[ "\${2:-}" == "pack" ]]; then
  node -e 'console.log(JSON.stringify({ path: process.env.TEST_TGZ }))'
  exit 0
fi
if [[ " $* " == *" --dry-run "* ]]; then
  printf '{"name":"@openclaw/demo-plugin","version":"2026.4.1"}\\n'
  exit 0
fi
attempts=0
if [[ -f "$TEST_ATTEMPTS" ]]; then attempts="$(cat "$TEST_ATTEMPTS")"; fi
attempts=$((attempts + 1))
printf '%s' "$attempts" > "$TEST_ATTEMPTS"
if ((attempts <= TEST_FAILURES)); then
  if [[ "$TEST_MUTATE" == "true" ]]; then printf x >> "$TEST_TGZ"; fi
  printf '%s\\n' "$TEST_ERROR" >&2
  exit "$TEST_EXIT_CODE"
fi
`,
      );
      chmodSync(join(binDir, "clawhub"), 0o755);

      const result = spawnSync(
        "bash",
        publishArgs(
          sourceMode ? "--publish" : "--publish-packed",
          sourceMode ? "extensions/demo-plugin" : tgzPath,
        ),
        publishOptions(repoDir, {
          ...env,
          OPENCLAW_CLAWHUB_PUBLISH_ATTEMPTS: "8",
          OPENCLAW_CLAWHUB_PUBLISH_RETRY_DELAY_SECONDS: "60",
          OPENCLAW_PLUGIN_NPM_RUNTIME_BUILD: "0",
          TEST_ATTEMPTS: attemptsPath,
          TEST_INVOCATIONS: markerPath,
          TEST_SLEEPS: sleepsPath,
          TEST_TGZ: tgzPath,
          TEST_FAILURES: "1",
          TEST_MUTATE: String(mutate ?? false),
          TEST_ERROR: error,
          TEST_EXIT_CODE: "1",
        }),
      );

      const publishOutput = `${result.stdout}\n${result.stderr}`;
      expect(existsSync(attemptsPath), publishOutput).toBe(true);
      expect(readFileSync(attemptsPath, "utf8"), publishOutput).toBe(String(attempts));
      expect(readFileSync(sleepsPath, "utf8")).toBe(sleeps.map((delay) => `${delay}\n`).join(""));
      expect(result.status === 0).toBe(attempts > 1 && !mutate);
      if (sourceMode) {
        expect(result.stderr).toContain("no caller-bound artifact identity");
      }
      if (error.includes("125s")) {
        expect(result.stderr).toContain("cap=300s");
      }
      if (!sourceMode) {
        const invocations = readFileSync(markerPath, "utf8");
        expect(invocations).not.toContain("package pack");
        expect(invocations.match(/immutable\.tgz/gu)).toHaveLength(attempts + 1);
      }
    },
  );
});

it("rejects unsafe git refs", () => {
  const repoDir = createTempPluginRepo();
  const headRef = git(repoDir, ["rev-parse", "HEAD"]);

  expect(() =>
    collectPluginClawHubReleasePathsFromGitRange({
      rootDir: repoDir,
      gitRange: { baseRef: "--not-a-ref", headRef },
    }),
  ).toThrow("baseRef must be a normal git ref or commit SHA.");
});

function writeClawHubPackStub(binDir: string, markerPath: string) {
  mkdirSync(binDir, { recursive: true });
  const clawhubPath = join(binDir, "clawhub");
  writeFileSync(
    clawhubPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(markerPath)}
if [[ "\${1:-}" == "--workdir" ]]; then
shift 2
fi
if [[ "\${1:-}" == "package" && "\${2:-}" == "pack" ]]; then
pack_destination=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --pack-destination)
      pack_destination="\${2:-}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
mkdir -p "$pack_destination"
pack_path="$pack_destination/openclaw-demo-plugin-2026.4.1.tgz"
printf 'fake tgz\\n' > "$pack_path"
printf '{"path":"%s","name":"@openclaw/demo-plugin","version":"2026.4.1"}\\n' "$pack_path"
fi
exit 0
`,
  );
  chmodSync(clawhubPath, 0o755);
}

function createTempPluginRepo(
  options: {
    extraExtensionIds?: string[];
    requiredLatestDependencyVersion?: string;
  } = {},
) {
  const repoDir = makeTempRepoRoot(tempDirs, "openclaw-clawhub-release-");

  writeFileSync(
    join(repoDir, "package.json"),
    JSON.stringify({ name: "openclaw-test-root", type: "module" }, null, 2),
  );
  writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  for (const currentExtensionId of ["demo-plugin", ...(options.extraExtensionIds ?? [])]) {
    writePublishablePluginFixture(repoDir, {
      extensionId: currentExtensionId,
      version: "2026.4.1",
      publishTo: "clawhub",
      dependency: options.requiredLatestDependencyVersion
        ? {
            packageName: "demo-runtime",
            version: options.requiredLatestDependencyVersion,
            requireLatest: true,
          }
        : undefined,
    });
  }

  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["add", "."]);
  git(repoDir, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "init",
  ]);

  return repoDir;
}

type RegistryReply = { status: number; body?: unknown };
function createClawHubPlanFetch(config: {
  packages: Record<string, RegistryReply>;
  trustedPublishers?: Record<string, RegistryReply>;
  versions?: Record<string, number>;
  publications?: Record<string, RegistryReply>;
}) {
  const requests: string[] = [];
  const reply = (value: RegistryReply | undefined, resource: string) => {
    if (!value) {
      throw new Error(`Unexpected ${resource} request`);
    }
    return new Response(JSON.stringify(value.body ?? {}), { status: value.status });
  };
  const fetchImpl: typeof fetch = async (input) => {
    const requestUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(requestUrl);
    requests.push(url.pathname);

    const match = url.pathname.match(
      /^\/api\/v1\/packages\/([^/]+)(?:\/(trusted-publisher)|\/versions\/([^/]+)(\/publication)?)?$/u,
    );
    if (!match?.[1]) {
      throw new Error(`Unexpected ClawHub request to ${url.pathname}`);
    }
    const name = decodeURIComponent(match[1]);
    if (match[2]) {
      return reply(config.trustedPublishers?.[name], `trusted-publisher for ${name}`);
    }
    if (match[3]) {
      const key = `${name}@${decodeURIComponent(match[3])}`;
      if (match[4]) {
        return reply(config.publications?.[key] ?? { status: 404 }, key);
      }
      const status =
        config.versions?.[key] ?? (config.packages[name]?.status === 404 ? 404 : undefined);
      return reply(status ? { status } : undefined, `version detail for ${key}`);
    }
    return reply(config.packages[name], `package detail for ${name}`);
  };

  return { fetchImpl, requests };
}

function git(cwd: string, args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
