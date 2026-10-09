// Plugin ClawHub release tests validate plugin release metadata and artifacts.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { gzipSync } from "node:zlib";
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

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function writeTarField(header: Buffer, offset: number, length: number, value: string) {
  const bytes = Buffer.from(value);
  if (bytes.byteLength > length) {
    throw new Error(`tar field exceeds ${length} bytes`);
  }
  bytes.copy(header, offset);
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number) {
  writeTarField(header, offset, length, `${value.toString(8).padStart(length - 2, "0")} \0`);
}

function createClawPackBytes(
  packageName: string,
  version: string,
  options: { duplicateNormalizedPackageJson?: boolean } = {},
) {
  function entry(name: string, contents: string, prefix = "") {
    const bytes = Buffer.from(contents);
    const header = Buffer.alloc(512);
    writeTarField(header, 0, 100, name);
    writeTarOctal(header, 100, 8, 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, bytes.byteLength);
    writeTarOctal(header, 136, 12, 0);
    header[156] = "0".charCodeAt(0);
    writeTarField(header, 257, 6, "ustar\0");
    writeTarField(header, 263, 2, "00");
    writeTarOctal(header, 329, 8, 0);
    writeTarOctal(header, 337, 8, 0);
    writeTarField(header, 345, 155, prefix);
    header.fill(0x20, 148, 156);
    const checksum = header.reduce((total, byte) => total + byte, 0);
    writeTarOctal(header, 148, 8, checksum);
    const padding = Buffer.alloc((512 - (bytes.byteLength % 512)) % 512);
    return Buffer.concat([header, bytes, padding]);
  }

  const packageJson = JSON.stringify({
    name: packageName,
    version,
    openclaw: { release: { publishToClawHub: true } },
  });
  const packageJsonEntries = options.duplicateNormalizedPackageJson
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
      const repoDir = createTempPluginRepo();
      const name = "@openclaw/demo-plugin";
      const version = "2026.4.1";
      const { fetchImpl, requests } = createClawHubPlanFetch({
        packages: { [name]: { status: 200 } },
        trustedPublishers: { [name]: { status: 200, body: { trustedPublisher } } },
        publications: {
          [`${name}@${version}`]: { status: 200, body: { name, version, ...publication } },
        },
        // A legacy probe would wrongly turn pending/failed into a publish candidate.
        versions: { [`${name}@${version}`]: 404 },
      });
      const plan = await collectPluginClawHubReleasePlan({ rootDir: repoDir, fetchImpl });
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
        `/api/v1/packages/%40openclaw%2Fdemo-plugin/versions/${version}/publication`,
      ]);
    },
  );

  it.each([{ state: "pending", stage: "staging" }])(
    "does not bootstrap a $state package shell hidden by the metadata route",
    async (publication) => {
      const repoDir = createTempPluginRepo();
      const name = "@openclaw/demo-plugin";
      const version = "2026.4.1";
      const { fetchImpl } = createClawHubPlanFetch({
        packages: { [name]: { status: 404 } },
        publications: {
          [`${name}@${version}`]: { status: 200, body: { name, version, ...publication } },
        },
      });
      const plan = await collectPluginClawHubReleasePlan({ rootDir: repoDir, fetchImpl });
      expect(plan.candidates).toEqual([]);
      expect(plan.bootstrapCandidates).toEqual([]);
      expect(plan.missingTrustedPublisher).toEqual([]);
      expect([...plan.pendingPublication, ...plan.failedPublication]).toEqual(plan.all);
      expect(plan.all[0]?.publication).toEqual(publication);
    },
  );

  it.each([
    { state: "future" },
    { state: "published", name: "@openclaw/wrong" },
    { state: "failed", recoverable: true, attemptId: "bad\ncommand" },
  ])("fails closed on invalid publication detail %j", async (publication) => {
    const repoDir = createTempPluginRepo();
    const name = "@openclaw/demo-plugin";
    const version = "2026.4.1";
    const { fetchImpl, requests } = createClawHubPlanFetch({
      packages: { [name]: { status: 200 } },
      trustedPublishers: { [name]: { status: 200, body: { trustedPublisher } } },
      publications: {
        [`${name}@${version}`]: { status: 200, body: { name, version, ...publication } },
      },
      versions: { [`${name}@${version}`]: 404 },
    });
    await expect(collectPluginClawHubReleasePlan({ rootDir: repoDir, fetchImpl })).rejects.toThrow(
      "Invalid ClawHub publication state",
    );
    expect(requests.some((url) => url.endsWith(`/versions/${version}`))).toBe(false);
  });

  it("bounds parallel ClawHub package-state reads and preserves plan order", async () => {
    const extraExtensionIds = Array.from({ length: 11 }, (_, index) => `demo-${index + 2}`);
    const repoDir = createTempPluginRepo({ extraExtensionIds });
    const packageNames = ["demo-plugin", ...extraExtensionIds].map(
      (extensionId) => `@openclaw/${extensionId}`,
    );
    const baseFetch = createClawHubPlanFetch({
      packages: Object.fromEntries(
        packageNames.map((packageName) => [packageName, { status: 200 }]),
      ),
      trustedPublishers: Object.fromEntries(
        packageNames.map((packageName) => [
          packageName,
          {
            status: 200,
            body: {
              trustedPublisher,
            },
          },
        ]),
      ),
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
    const fetchImpl: typeof fetch = async (input) => {
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const pathname = new URL(requestUrl).pathname;
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin") {
        return new Response("{}", { status: 200 });
      }
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/trusted-publisher") {
        return new Response(
          JSON.stringify({
            trustedPublisher,
          }),
          { status: 200 },
        );
      }
      if (pathname.endsWith("/publication")) {
        return new Response(null, { status: 404 });
      }
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/versions/2026.4.1") {
        versionRequests += 1;
        if (versionRequests === 1) {
          throw new TypeError("fetch failed");
        }
        return new Response("", { status: 404 });
      }
      throw new Error(`Unexpected ClawHub request to ${pathname}`);
    };

    const plan = await collectPluginClawHubReleasePlan({
      rootDir: repoDir,
      selection: ["@openclaw/demo-plugin"],
      fetchImpl,
      registryBaseUrl: "https://clawhub.ai",
      sleep: async (ms) => {
        retryDelays.push(ms);
      },
    });

    expect(versionRequests).toBe(2);
    expect(retryDelays).toEqual([1_000]);
    expect(plan.candidates.map((plugin) => plugin.packageName)).toEqual(["@openclaw/demo-plugin"]);
  });

  it("preserves ClawHub response details after package retries are exhausted", async () => {
    const repoDir = createTempPluginRepo();
    let packageRequests = 0;
    await expect(
      collectPluginClawHubReleasePlan({
        rootDir: repoDir,
        selection: ["@openclaw/demo-plugin"],
        registryBaseUrl: "https://clawhub.ai",
        fetchImpl: async () => {
          packageRequests += 1;
          return new Response("Rate limit temporarily unavailable", {
            status: 503,
            headers: {
              "Retry-After": "1",
              "x-request-id": "request-123",
            },
          });
        },
        sleep: async () => {},
      }),
    ).rejects.toThrow(
      "Failed to query ClawHub package @openclaw/demo-plugin: 503 Rate limit temporarily unavailable [retry-after=1; x-request-id=request-123]",
    );
    expect(packageRequests).toBe(4);
  });

  it.each([
    {
      caseName: "preserves a complete surrogate pair",
      responseBody: `${"x".repeat(398)}\u{1f600}tail`,
      expectedDetail: `${"x".repeat(398)}\u{1f600}...`,
    },
  ])(
    "keeps ClawHub error truncation UTF-16 safe: $caseName",
    async ({ responseBody, expectedDetail }) => {
      const repoDir = createTempPluginRepo();
      await expect(
        collectPluginClawHubReleasePlan({
          rootDir: repoDir,
          selection: ["@openclaw/demo-plugin"],
          registryBaseUrl: "https://clawhub.ai",
          fetchImpl: async () => new Response(responseBody, { status: 503 }),
          sleep: async () => {},
        }),
      ).rejects.toThrow(
        `Failed to query ClawHub package @openclaw/demo-plugin: 503 ${expectedDetail}`,
      );
    },
  );

  it("honors an HTTP-date Retry-After header", async () => {
    const repoDir = createTempPluginRepo();
    const retryAfter = "Wed, 21 Oct 2030 07:28:00 GMT";
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse(retryAfter) - 1_000);
    let trustedPublisherRequests = 0;
    const retryDelays: number[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const pathname = new URL(requestUrl).pathname;
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin") {
        return new Response("{}", { status: 200 });
      }
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/trusted-publisher") {
        trustedPublisherRequests += 1;
        if (trustedPublisherRequests === 1) {
          return new Response("", { status: 429, headers: { "retry-after": retryAfter } });
        }
        return new Response(
          JSON.stringify({
            trustedPublisher,
          }),
          { status: 200 },
        );
      }
      if (pathname.endsWith("/publication")) {
        return new Response(null, { status: 404 });
      }
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/versions/2026.4.1") {
        return new Response("", { status: 404 });
      }
      throw new Error(`Unexpected ClawHub request to ${pathname}`);
    };

    try {
      await collectPluginClawHubReleasePlan({
        rootDir: repoDir,
        selection: ["@openclaw/demo-plugin"],
        fetchImpl,
        registryBaseUrl: "https://clawhub.ai",
        sleep: async (ms) => {
          retryDelays.push(ms);
        },
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(trustedPublisherRequests).toBe(2);
    expect(retryDelays).toEqual([1_000]);
  });

  it("falls back to the bounded retry schedule for an excessive Retry-After header", async () => {
    const repoDir = createTempPluginRepo();
    let trustedPublisherRequests = 0;
    const retryDelays: number[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const pathname = new URL(requestUrl).pathname;
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin") {
        return new Response("{}", { status: 200 });
      }
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/trusted-publisher") {
        trustedPublisherRequests += 1;
        if (trustedPublisherRequests === 1) {
          return new Response("", { status: 429, headers: { "retry-after": "999999999999" } });
        }
        return new Response(
          JSON.stringify({
            trustedPublisher,
          }),
          { status: 200 },
        );
      }
      if (pathname.endsWith("/publication")) {
        return new Response(null, { status: 404 });
      }
      if (pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/versions/2026.4.1") {
        return new Response("", { status: 404 });
      }
      throw new Error(`Unexpected ClawHub request to ${pathname}`);
    };

    await collectPluginClawHubReleasePlan({
      rootDir: repoDir,
      selection: ["@openclaw/demo-plugin"],
      fetchImpl,
      registryBaseUrl: "https://clawhub.ai",
      sleep: async (ms) => {
        retryDelays.push(ms);
      },
    });

    expect(trustedPublisherRequests).toBe(2);
    expect(retryDelays).toEqual([1_000]);
  });

  it("keeps ClawHub trusted publisher timeouts active while reading response bodies", async () => {
    const repoDir = createTempPluginRepo();
    const fetchImpl: typeof fetch = async (input) => {
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(requestUrl);
      if (url.pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin") {
        return new Response("{}", { status: 200 });
      }
      if (url.pathname === "/api/v1/packages/%40openclaw%2Fdemo-plugin/trusted-publisher") {
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
      }
      throw new Error(`Unexpected ClawHub request to ${url.pathname}`);
    };

    await expect(
      collectPluginClawHubReleasePlan({
        rootDir: repoDir,
        selection: ["@openclaw/demo-plugin"],
        fetchImpl,
        registryBaseUrl: "https://clawhub.ai",
        requestTimeoutMs: 5,
      }),
    ).rejects.toThrow("ClawHub request timed out after 5ms");
  });

  it("routes environment-pinned trusted publisher config out of normal candidates", async () => {
    const repoDir = createTempPluginRepo();
    const { fetchImpl } = createClawHubPlanFetch({
      packages: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            package: {},
            owner: {},
          },
        },
      },
      trustedPublishers: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            trustedPublisher: {
              repository: "openclaw/openclaw",
              workflowFilename: "plugin-clawhub-release.yml",
              environment: "clawhub-plugin-release",
            },
          },
        },
      },
      versions: {
        "@openclaw/demo-plugin@2026.4.1": 404,
      },
    });

    const plan = await collectPluginClawHubReleasePlan({
      rootDir: repoDir,
      selection: ["@openclaw/demo-plugin"],
      fetchImpl,
      registryBaseUrl: "https://clawhub.ai",
    });

    expect(plan.candidates).toStrictEqual([]);
    expect(plan.bootstrapCandidates).toStrictEqual([]);
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
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            package: {},
            owner: {},
          },
        },
        "@openclaw/demo-two": {
          status: 404,
        },
        "@openclaw/demo-three": {
          status: 200,
          body: {
            package: {},
            owner: {},
          },
        },
      },
      trustedPublishers: {
        "@openclaw/demo-plugin": {
          status: 200,
          body: {
            trustedPublisher,
          },
        },
        "@openclaw/demo-three": {
          status: 200,
          body: {
            trustedPublisher: null,
          },
        },
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
    expect(plan.clawHubWorkflowRef).toBe(`release-publish/${"d".repeat(12)}-12345`);
    expect(plan.bootstrapWorkflowSha).toBe("d".repeat(40));
    expect(plan.releasePublishBranch).toBe("main");
    expect(plan.normal).toEqual({
      workflow: "plugin-clawhub-release.yml",
      ref: `release-publish/${"d".repeat(12)}-12345`,
      shouldDispatch: true,
      packages: ["@openclaw/demo-plugin"],
      inputs: {
        publish_scope: "selected",
        ref: "a".repeat(40),
        release_tag: "v2026.4.1-beta.1",
        plugins: "@openclaw/demo-plugin",
        release_publish_full_ref: "refs/heads/main",
        release_publish_run_attempt: "2",
        release_publish_run_id: "12345",
        release_publish_branch: "main",
        release_publish_workflow_sha: "d".repeat(40),
      },
    });
    expect(plan.bootstrap).toEqual({
      workflow: "plugin-clawhub-new.yml",
      ref: `release-publish/${"d".repeat(12)}-12345`,
      shouldDispatch: true,
      packages: ["@openclaw/demo-two", "@openclaw/demo-three"],
      inputs: {
        bootstrap_workflow_sha: "d".repeat(40),
        ref: "a".repeat(40),
        release_tag: "v2026.4.1-beta.1",
        plugins: "@openclaw/demo-two,@openclaw/demo-three",
        release_publish_run_attempt: "2",
        release_publish_run_id: "12345",
        release_publish_branch: "main",
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

  it("requires an exact lowercase release SHA for bootstrap targeting", () => {
    const baseArgs = [
      "--bootstrap-workflow-ref",
      `release-publish/${"d".repeat(12)}-12345`,
      "--bootstrap-workflow-sha",
      "d".repeat(40),
      "--release-tag",
      "v2026.4.1-beta.1",
      "--release-publish-branch",
      "release/2026.4.1",
      "--release-publish-run-attempt",
      "1",
      "--release-publish-run-id",
      "12345",
    ];
    expect(() => parseOpenClawReleaseClawHubPlanArgs(baseArgs)).toThrow(
      "--release-sha is required.",
    );
    expect(() =>
      parseOpenClawReleaseClawHubPlanArgs([...baseArgs, "--release-sha", "ABCDEF"]),
    ).toThrow("--release-sha must be a full 40-character lowercase commit SHA.");
  });

  it("requires an exact parent release run attempt for bootstrap approval binding", () => {
    const args = [
      "--bootstrap-workflow-ref",
      `release-publish/${"d".repeat(12)}-12345`,
      "--bootstrap-workflow-sha",
      "d".repeat(40),
      "--release-tag",
      "v2026.4.1-beta.1",
      "--release-sha",
      "c".repeat(40),
      "--release-publish-branch",
      "main",
      "--release-publish-full-ref",
      "refs/heads/main",
      "--release-publish-run-id",
      "12345",
    ];
    expect(() => parseOpenClawReleaseClawHubPlanArgs(args)).toThrow(
      "--release-publish-run-attempt is required.",
    );
    expect(() =>
      parseOpenClawReleaseClawHubPlanArgs([...args, "--release-publish-run-attempt", "0"]),
    ).toThrow("--release-publish-run-attempt must be a positive integer.");
  });
});

describe("plugin-clawhub-publish.sh", () => {
  it("passes the release-plan package family to ClawHub publish", () => {
    const repoDir = createTempPluginRepo();
    const binDir = join(repoDir, "bin");
    const markerPath = join(repoDir, "clawhub-invoked");
    writeClawHubPackStub(binDir, markerPath);

    execFileSync(
      "bash",
      [
        join(process.cwd(), "scripts/plugin-clawhub-publish.sh"),
        "--dry-run",
        "extensions/demo-plugin",
      ],
      {
        cwd: repoDir,
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_CLAWHUB_PACKAGE_FAMILY: "bundle-plugin",
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(readFileSync(markerPath, "utf8")).toContain("--family bundle-plugin");
  });

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
    const result = spawnSync(
      "bash",
      [
        join(process.cwd(), "scripts/plugin-clawhub-publish.sh"),
        "--pack",
        "extensions/demo-plugin",
      ],
      { cwd: repoDir, encoding: "utf8", env: { ...process.env, OPENCLAW_CLAWHUB_CLI: cli } },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("OPENCLAW_CLAWHUB_CLI must be an absolute executable path");
  });

  it("packs a reusable workflow artifact without publishing", () => {
    const repoDir = createTempPluginRepo();
    const binDir = join(repoDir, "bin");
    const markerPath = join(repoDir, "clawhub-invoked");
    const outputDir = join(repoDir, "clawhub-artifacts");
    writeClawHubPackStub(binDir, markerPath);

    const output = execFileSync(
      "bash",
      [
        join(process.cwd(), "scripts/plugin-clawhub-publish.sh"),
        "--pack",
        "extensions/demo-plugin",
      ],
      {
        cwd: repoDir,
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_CLAWHUB_PACK_OUTPUT_DIR: outputDir,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(output).toContain("Packed ClawPack:");
    expect(existsSync(join(outputDir, "openclaw-demo-plugin-2026.4.1.tgz"))).toBe(true);
    const invocations = readFileSync(markerPath, "utf8");
    expect(invocations).toContain("package pack ");
    expect(invocations).not.toContain("package publish ");
  });

  it("rejects duplicate normalized paths before invoking the ClawHub CLI", () => {
    const repoDir = createTempPluginRepo();
    const binDir = join(repoDir, "bin");
    const markerPath = join(repoDir, "clawhub-invoked");
    const tgzPath = join(repoDir, "ambiguous.tgz");
    const tgzBytes = createClawPackBytes("@openclaw/demo-plugin", "2026.4.1", {
      duplicateNormalizedPackageJson: true,
    });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(tgzPath, tgzBytes);
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
      execFileSync(
        "bash",
        [join(process.cwd(), "scripts/plugin-clawhub-publish.sh"), "--validate-packed", tgzPath],
        {
          cwd: repoDir,
          encoding: "utf8",
          env: {
            ...process.env,
            EXPECTED_CLAWHUB_ARTIFACT_SHA256: createHash("sha256").update(tgzBytes).digest("hex"),
            EXPECTED_CLAWHUB_ARTIFACT_SIZE: String(tgzBytes.byteLength),
            EXPECTED_CLAWHUB_PACKAGE_NAME: "@openclaw/demo-plugin",
            EXPECTED_CLAWHUB_PACKAGE_VERSION: "2026.4.1",
            PACKAGE_DIR: "extensions/demo-plugin",
            PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
          },
        },
      ),
    ).toThrow("Duplicate or aliased plugin tar entry: package/package.json");
    expect(existsSync(markerPath)).toBe(false);
  });

  it.each([
    {
      name: "honors CLI Retry-After",
      error: "Rate limit exceeded (retry in 125s, remaining: 0/10, reset in 125s)",
      failures: 1,
      sleeps: [125],
      attempts: 2,
    },
    {
      name: "refuses source-mode replay without a bound identity",
      error: "HTTP 503",
      failures: 1,
      sleeps: [],
      attempts: 1,
      sourceMode: true,
      diagnostic: "no caller-bound artifact identity",
    },
    {
      name: "refuses changed artifact bytes",
      error: "HTTP 503",
      failures: 1,
      sleeps: [60],
      attempts: 1,
      mutate: true,
    },
  ])("$name", ({ error, failures, sleeps, attempts, sourceMode, mutate, diagnostic }) => {
    const repoDir = createTempPluginRepo();
    if (sourceMode) {
      const runtimeDir = join(repoDir, "extensions/demo-plugin/dist");
      mkdirSync(runtimeDir, { recursive: true });
      writeFileSync(join(runtimeDir, "index.js"), "export {};\n");
    }
    const binDir = join(repoDir, "bin");
    const markerPath = join(repoDir, "clawhub-invoked");
    const attemptsPath = join(repoDir, "publish-attempts");
    const sleepsPath = join(repoDir, "sleeps");
    const tgzPath = join(repoDir, "immutable.tgz");
    const tgzBytes = createClawPackBytes("@openclaw/demo-plugin", "2026.4.1");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(tgzPath, tgzBytes);
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
      [
        join(process.cwd(), "scripts/plugin-clawhub-publish.sh"),
        sourceMode ? "--publish" : "--publish-packed",
        sourceMode ? "extensions/demo-plugin" : tgzPath,
      ],
      {
        cwd: repoDir,
        encoding: "utf8",
        env: {
          ...process.env,
          EXPECTED_CLAWHUB_ARTIFACT_SHA256: createHash("sha256").update(tgzBytes).digest("hex"),
          EXPECTED_CLAWHUB_ARTIFACT_SIZE: String(tgzBytes.byteLength),
          EXPECTED_CLAWHUB_PACKAGE_NAME: "@openclaw/demo-plugin",
          EXPECTED_CLAWHUB_PACKAGE_VERSION: "2026.4.1",
          OPENCLAW_CLAWHUB_PUBLISH_ATTEMPTS: "8",
          OPENCLAW_CLAWHUB_PUBLISH_RETRY_DELAY_SECONDS: "60",
          OPENCLAW_PLUGIN_NPM_RUNTIME_BUILD: "0",
          PACKAGE_DIR: "extensions/demo-plugin",
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
          TEST_ATTEMPTS: attemptsPath,
          TEST_INVOCATIONS: markerPath,
          TEST_SLEEPS: sleepsPath,
          TEST_TGZ: tgzPath,
          TEST_FAILURES: String(failures),
          TEST_MUTATE: String(mutate ?? false),
          TEST_ERROR: error,
          TEST_EXIT_CODE: "1",
        },
      },
    );

    const publishOutput = `${result.stdout}\n${result.stderr}`;
    expect(existsSync(attemptsPath), publishOutput).toBe(true);
    expect(readFileSync(attemptsPath, "utf8"), publishOutput).toBe(String(attempts));
    expect(readFileSync(sleepsPath, "utf8")).toBe(sleeps.map((delay) => `${delay}\n`).join(""));
    expect(result.status === 0).toBe(attempts > failures && !mutate);
    if (diagnostic) {
      expect(result.stderr).toContain(diagnostic);
    }
    if (error.includes("125s")) {
      expect(result.stderr).toContain("cap=300s");
    }
    if (!sourceMode) {
      const invocations = readFileSync(markerPath, "utf8");
      expect(invocations).not.toContain("package pack");
      expect(invocations.match(/immutable\.tgz/gu)).toHaveLength(attempts + 1);
    }
  });
});

describe("collectPluginClawHubReleasePathsFromGitRange", () => {
  it("rejects unsafe git refs", () => {
    const repoDir = createTempPluginRepo();
    const headRef = git(repoDir, ["rev-parse", "HEAD"]);

    expect(() =>
      collectPluginClawHubReleasePathsFromGitRange({
        rootDir: repoDir,
        gitRange: {
          baseRef: "--not-a-ref",
          headRef,
        },
      }),
    ).toThrow("baseRef must be a normal git ref or commit SHA.");
  });
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
  const extensionIds = ["demo-plugin", ...(options.extraExtensionIds ?? [])];

  writeFileSync(
    join(repoDir, "package.json"),
    JSON.stringify({ name: "openclaw-test-root", type: "module" }, null, 2),
  );
  writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  for (const currentExtensionId of extensionIds) {
    writePublishablePluginFixture(repoDir, {
      extensionId: currentExtensionId,
      version: "2026.4.1",
      publishTo: "clawhub",
      ...(options.requiredLatestDependencyVersion
        ? {
            dependency: {
              packageName: "demo-runtime",
              version: options.requiredLatestDependencyVersion,
              requireLatest: true,
            },
          }
        : {}),
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

function createClawHubPlanFetch(config: {
  packages: Record<
    string,
    {
      status: number;
      body?: unknown;
    }
  >;
  trustedPublishers?: Record<
    string,
    {
      status: number;
      body?: unknown;
    }
  >;
  versions?: Record<string, number>;
  publications?: Record<string, { status: number; body?: unknown }>;
}) {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const requestUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(requestUrl);
    requests.push(url.pathname);

    const packageMatch = url.pathname.match(/^\/api\/v1\/packages\/([^/]+)$/u);
    const encodedPackageName = packageMatch?.[1];
    if (encodedPackageName !== undefined) {
      const packageName = decodeURIComponent(encodedPackageName);
      const packageResponse = config.packages[packageName];
      if (!packageResponse) {
        throw new Error(`Unexpected package detail request for ${packageName}`);
      }
      return new Response(JSON.stringify(packageResponse.body ?? {}), {
        status: packageResponse.status,
      });
    }

    const trustedPublisherMatch = url.pathname.match(
      /^\/api\/v1\/packages\/([^/]+)\/trusted-publisher$/u,
    );
    const encodedTrustedPublisherPackageName = trustedPublisherMatch?.[1];
    if (encodedTrustedPublisherPackageName !== undefined) {
      const packageName = decodeURIComponent(encodedTrustedPublisherPackageName);
      const trustedPublisherResponse = config.trustedPublishers?.[packageName];
      if (!trustedPublisherResponse) {
        throw new Error(`Unexpected trusted-publisher request for ${packageName}`);
      }
      return new Response(JSON.stringify(trustedPublisherResponse.body ?? {}), {
        status: trustedPublisherResponse.status,
      });
    }

    const publicationMatch = url.pathname.match(
      /^\/api\/v1\/packages\/([^/]+)\/versions\/([^/]+)\/publication$/u,
    );
    if (publicationMatch?.[1] && publicationMatch[2]) {
      const key = `${decodeURIComponent(publicationMatch[1])}@${decodeURIComponent(publicationMatch[2])}`;
      const reply = config.publications?.[key] ?? { status: 404 };
      return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
    }

    const versionMatch = url.pathname.match(/^\/api\/v1\/packages\/([^/]+)\/versions\/([^/]+)$/u);
    const encodedVersionPackageName = versionMatch?.[1];
    const encodedVersion = versionMatch?.[2];
    if (encodedVersionPackageName !== undefined && encodedVersion !== undefined) {
      const packageName = decodeURIComponent(encodedVersionPackageName);
      const version = decodeURIComponent(encodedVersion);
      const status =
        config.versions?.[`${packageName}@${version}`] ??
        (config.packages[packageName]?.status === 404 ? 404 : undefined);
      if (!status) {
        throw new Error(`Unexpected version detail request for ${packageName}@${version}`);
      }
      return new Response("{}", { status });
    }

    throw new Error(`Unexpected ClawHub request to ${url.pathname}`);
  };

  return { fetchImpl, requests };
}

function git(cwd: string, args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
