import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../../src/config/types.plugins.js";
import { checkClawHubPackageTrust } from "../../src/infra/clawhub-install-trust.js";
import { withinTest } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writePluginInspectFixture } from "./plugin-inspect.test-support.js";

const SCRIPT_PATH = path.resolve("scripts/e2e/lib/clawhub-fixture-server.cjs");
const servers: ChildProcess[] = [];

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.unstubAllGlobals();
    // Keep startup records and artifacts alive until every fixture process has exited.
    await Promise.all(servers.splice(0).map(stopServer));
    cleanup();
  }),
);

function writeJson(file: string, value: unknown, suffix = "") {
  writeFileSync(file, JSON.stringify(value) + suffix, "utf8");
}

function packFixture(root: string, tarball: string, files: Record<string, unknown>, suffix = "") {
  const packageDir = path.join(root, "package");
  mkdirSync(packageDir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    writeJson(path.join(packageDir, name), value, suffix);
  }
  const tarballPath = path.join(root, tarball);
  execFileSync("tar", ["-czf", tarballPath, "-C", root, "package"]);
  const archive = readFileSync(tarballPath);
  return {
    packageDir,
    tarballPath,
    archive,
    sha256: createHash("sha256").update(archive).digest("hex"),
  };
}

async function auditTrust(baseUrl: string, packageName: string, version: string) {
  const auditMessages: string[] = [];
  const trust = await checkClawHubPackageTrust({
    subject: { kind: "plugin", packageName },
    version,
    baseUrl,
    mode: "update",
    logger: { info: (message) => auditMessages.push(message) },
  });
  return { trust, auditMessages };
}

function expectFailure(result: { status: number | null; stderr: string }, message: string) {
  expect(result).toMatchObject({ status: 1, stderr: expect.stringContaining(message) });
}

function collectStream(stream: NodeJS.ReadableStream) {
  let text = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    text += chunk;
  });
  return () => text;
}

async function stopServer(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.kill("SIGTERM");
  await exited;
}

async function startFixtureServer(
  profile: string,
  signal: AbortSignal,
  args: string[] = [],
  cwd = process.cwd(),
) {
  const root = tempDirs.make("openclaw-clawhub-fixture-server-");
  const portFile = path.join(root, "port");
  const child = spawn(process.execPath, [SCRIPT_PATH, profile, portFile, ...args], {
    cwd,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const readStdout = collectStream(expectDefined(child.stdout, "fixture stdout pipe"));
  const readStderr = collectStream(expectDefined(child.stderr, "fixture stderr pipe"));
  servers.push(child);

  // The fixture publishes its port only after listen and the synchronous port-file write.
  let onMessage: (message: unknown) => void = () => {};
  let onClose = () => {};
  let onError: (error: Error) => void = () => {};
  const ready = new Promise<number>((resolve, reject) => {
    onMessage = (message) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "port" in message &&
        typeof message.port === "number" &&
        Number.isInteger(message.port) &&
        message.port > 0
      ) {
        resolve(message.port);
      }
    };
    onClose = () =>
      reject(
        new Error(`fixture server exited early: stdout=${readStdout()} stderr=${readStderr()}`),
      );
    onError = reject;
    child.on("message", onMessage);
    child.once("close", onClose);
    child.once("error", onError);
  });
  try {
    const port = await withinTest(ready, signal);
    expect(Number(readFileSync(portFile, "utf8"))).toBe(port);
    return { baseUrl: `http://127.0.0.1:${port}` };
  } finally {
    child.off("message", onMessage);
    child.off("close", onClose);
    child.off("error", onError);
  }
}

async function fetchJson(baseUrl: string, requestPath: string) {
  const response = await fetch(`${baseUrl}${requestPath}`);
  expect(response.status).toBe(200);
  return response.json();
}

function runFixtureAssertion(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env },
  });
}

describe("ClawHub fixture server", () => {
  it("serves an accepted install audit for the kitchen-sink-plugin profile", async ({ signal }) => {
    const { baseUrl } = await startFixtureServer("kitchen-sink-plugin", signal);
    const packageName = "@openclaw/kitchen-sink";
    const version = "0.2.5";
    const { trust, auditMessages } = await auditTrust(baseUrl, packageName, version);
    expect(trust.ok).toBe(true);
    expect(auditMessages).toHaveLength(1);
    for (const fragment of [
      "Outcome: Safe",
      "No security concerns found in the fixture release.",
      `${baseUrl}/api/v1/packages/${encodeURIComponent(packageName)}/versions/${version}/security`,
    ]) {
      expect(auditMessages[0]).toContain(fragment);
    }
  });

  it("serves exact prepublish tarballs through the ClawHub artifact contract", async ({
    signal,
  }) => {
    const root = tempDirs.make("openclaw-clawhub-prepublish-");
    const isolatedCwd = tempDirs.make("openclaw-clawhub-isolated-");
    const version = "2026.8.1-beta.1";
    const tarball = "openclaw-whatsapp-2026.8.1-beta.1.tgz";
    const { packageDir, tarballPath, archive, sha256 } = packFixture(
      root,
      tarball,
      {
        "package.json": {
          name: "@openclaw/whatsapp",
          version,
          openclaw: { extensions: ["./index.js"] },
        },
        "openclaw.plugin.json": { id: "whatsapp", configSchema: { type: "object" } },
      },
      "\n",
    );
    const npmIntegrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
    const npmShasum = createHash("sha1").update(archive).digest("hex");
    const coreTarball = "openclaw-ai.tgz";
    const core = packFixture(path.join(root, "core"), coreTarball, {
      "package.json": { name: "@openclaw/ai", version },
    });
    cpSync(core.tarballPath, path.join(root, coreTarball));
    const manifestPath = path.join(root, "prepublish-plugin-registry.json");
    writeJson(
      manifestPath,
      {
        packages: [
          { name: "@openclaw/ai", version, tarball: coreTarball, sha256: core.sha256 },
          { name: "@openclaw/whatsapp", version, tarball, sha256 },
        ],
      },
      "\n",
    );

    const { baseUrl } = await startFixtureServer(
      "prepublish-artifacts",
      signal,
      [manifestPath],
      isolatedCwd,
    );
    const assertRequests = (
      attempts?: number | "complete",
      minimumAttempts?: number,
      url = baseUrl,
    ) =>
      runFixtureAssertion(
        isolatedCwd,
        "assert-prepublish-requests",
        url,
        "@openclaw/whatsapp",
        version,
        "required",
        ...(attempts ? [String(attempts)] : []),
        ...(minimumAttempts ? [String(minimumAttempts)] : []),
      );
    const noRequests = () => runFixtureAssertion(isolatedCwd, "assert-no-requests", baseUrl);
    expect(noRequests().status).toBe(0);
    const stateDir = path.join(isolatedCwd, "state");
    const installPath = path.join(
      stateDir,
      "npm/projects/whatsapp/node_modules/@openclaw/whatsapp",
    );
    cpSync(packageDir, installPath, { recursive: true });
    const registryDir = path.join(isolatedCwd, "registry");
    mkdirSync(registryDir);
    cpSync(tarballPath, path.join(registryDir, tarball));
    const registryManifest = JSON.stringify({
      schema: "openclaw.prepublish-plugin-registry/v1",
      schemaVersion: 1,
      sourceSha: "a".repeat(40),
      candidateVersion: version,
      packages: [{ name: "@openclaw/whatsapp", version, tarball, sha256 }],
    });
    writeFileSync(path.join(registryDir, "prepublish-plugin-registry.json"), registryManifest);
    const npmRecord: PluginInstallRecord = {
      source: "npm",
      spec: `@openclaw/whatsapp@${version}`,
      resolvedName: "@openclaw/whatsapp",
      resolvedVersion: version,
      integrity: npmIntegrity,
      installPath,
    };
    const bin = path.join(isolatedCwd, "bin");
    const runner = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
    const boundary = runner.indexOf("phase storage-preflight");
    expect(boundary).toBeGreaterThan(0);
    // Execute the automatic source checks on both sides of the real consent phase.
    // The existing server owns the empty ledger; package files and consent remain real inputs.
    const automaticPhases = `${runner.slice(0, boundary)}
trap - EXIT ERR HUP INT TERM
candidate_version="$FIXTURE_VERSION"
baseline_version=2026.7.1-2
update_repair_required="$FIXTURE_PENDING"
phase() {
  local name="$1"
  shift
  case "$name" in
    assert-prepublish-requests|assert-prepublish-recovery-requests)
      "$@"
      printf '%s passed\n' "$name"
      [ "$FIXTURE_PENDING" != 1 ] || exit 0
      ;;
    fixture-plugin-consent) "$@"; exit "$?" ;;
    *) : ;;
  esac
}
${runner.slice(boundary)}
`;
    // The full runner exceeds Linux's per-argument limit when passed to bash -c.
    const automaticPhasesPath = path.join(root, "automatic-phases.sh");
    writeFileSync(automaticPhasesPath, automaticPhases);
    const openclawArgvLog = path.join(root, "openclaw-argv.log");
    const runAutomaticChecks = (
      record: PluginInstallRecord | null = npmRecord,
      deniedPluginId?: string,
    ) => {
      mkdirSync(path.join(stateDir, "plugins"), { recursive: true });
      writeJson(path.join(stateDir, "plugins", "installs.json"), {
        installRecords: record ? { whatsapp: record } : {},
      });
      const fixtureEnv = writePluginInspectFixture(bin, record ? { whatsapp: record } : {});
      writeFileSync(openclawArgvLog, "");
      const artifacts = path.join(isolatedCwd, "artifacts");
      mkdirSync(artifacts, { recursive: true });
      writeJson(path.join(artifacts, "update.json"), {
        status: "error",
        mode: "npm",
        reason: "post-update-plugins",
        before: { version: "2026.7.1-2" },
        after: { version },
        steps: [
          { name: "global update", exitCode: 0 },
          { name: "global install swap", exitCode: 0 },
        ],
        postUpdate: {
          plugins: {
            status: "error",
            warnings: [],
            sync: { errors: [] },
            integrityDrifts: [],
            npm: {
              outcomes: [
                {
                  pluginId: deniedPluginId,
                  status: "error",
                  code: "PLUGIN_CAPABILITY_CONSENT_REQUIRED",
                },
              ],
            },
          },
        },
      });
      return spawnSync(
        process.platform === "darwin" ? "/bin/bash" : "bash",
        [automaticPhasesPath],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            ...fixtureEnv,
            HOME: isolatedCwd,
            FIXTURE_VERSION: version,
            FIXTURE_PENDING: deniedPluginId ? "1" : "0",
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_CLAWHUB_URL: baseUrl,
            OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: registryDir,
            OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256: createHash("sha256")
              .update(registryManifest)
              .digest("hex"),
            OPENCLAW_DOCKER_E2E_SELECTED_SHA: "a".repeat(40),
            OPENCLAW_TEST_OPENCLAW_ARGV_LOG: openclawArgvLog,
            OPENCLAW_UPGRADE_SURVIVOR_BASELINE: "openclaw@2026.7.1-2",
            OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "base",
            OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE: "manual",
            OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: path.join(isolatedCwd, "runtime"),
            OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON: path.join(
              isolatedCwd,
              "artifacts/summary.json",
            ),
          },
        },
      );
    };
    const automatic = runAutomaticChecks();
    expect(automatic.status, automatic.stdout + automatic.stderr).toBe(0);
    expect(automatic.stdout).toContain("assert-prepublish-requests passed");
    expect(automatic.stdout).toContain("assert-prepublish-recovery-requests passed");
    expect(
      readFileSync(openclawArgvLog, "utf8")
        .split("\n")
        .filter((line) => line === "plugins install --help"),
    ).toHaveLength(1);
    expect(automatic.stdout).toContain(
      'Plugin "whatsapp" has verified official capability-consent exemption.',
    );
    for (const [record, failure] of [
      [null, "plugin install record missing"],
      [{ ...npmRecord, source: "path" }, "must be installed from npm"],
      [{ ...npmRecord, installPath: `${installPath}-missing` }, "installPath missing on disk"],
      [{ ...npmRecord, resolvedVersion: "2026.8.0" }, "plugin version changed"],
      [{ ...npmRecord, integrity: undefined }, "plugin integrity missing"],
      [{ ...npmRecord, integrity: "sha512-wrong" }, "registry artifact integrity"],
      [
        { ...npmRecord, sourcePath: tarballPath, artifactKind: "npm-pack" },
        "plugin accepted surface missing",
      ],
      [{ ...npmRecord, resolvedName: "@vendor/whatsapp" }, "plugin accepted surface missing"],
    ] as const) {
      const rejected = runAutomaticChecks(record);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(failure);
    }
    const pending = runAutomaticChecks(null, "whatsapp");
    expect(pending.status, pending.stderr).toBe(0);
    expect(pending.stdout).toContain('Plugin "whatsapp" is awaiting fixture capability consent.');
    expectFailure(runAutomaticChecks(null, "discord"), "whatsapp plugin install record missing");
    expect(assertRequests("complete").status).toBe(1);
    const whatsappPath = `/api/v1/packages/${encodeURIComponent("@openclaw/whatsapp")}`;
    const versionPath = `${whatsappPath}/versions/${version}`;
    const completeRequestPaths = [
      whatsappPath,
      `${versionPath}/artifact`,
      `${versionPath}/security`,
      `${versionPath}/artifact/download`,
    ];
    const detail = await fetchJson(baseUrl, whatsappPath);
    expect(detail.package).toMatchObject({
      latestVersion: version,
      runtimeId: "whatsapp",
      tags: { beta: version, latest: version },
    });
    const artifact = await fetchJson(baseUrl, `${versionPath}/artifact`);
    expect(artifact.artifact).toMatchObject({ artifactKind: "npm-pack", artifactSha256: sha256 });
    const securityUrl = `${baseUrl}${versionPath}/security`;
    const fetchImpl = globalThis.fetch;
    let security: unknown;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const response = await fetchImpl(input, init);
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (requestUrl === securityUrl) {
        security = await response.clone().json();
      }
      return response;
    });
    const { trust, auditMessages } = await auditTrust(baseUrl, "@openclaw/whatsapp", version);
    expect(security).toEqual({
      package: {
        name: "@openclaw/whatsapp",
        displayName: "@openclaw/whatsapp",
        family: "code-plugin",
      },
      release: {
        releaseId: `fixture:@openclaw/whatsapp@${version}`,
        version,
        artifactKind: "npm-pack",
        artifactSha256: sha256,
        npmIntegrity,
        npmShasum,
        npmTarballName: tarball,
        createdAt: 0,
      },
      overview: "No security concerns found in the fixture release.",
      verdict: "clean",
      securityAuditUrl: securityUrl,
      trust: {
        scanStatus: "clean",
        moderationState: null,
        blockedFromDownload: false,
        reasons: [],
        pending: false,
        stale: false,
      },
    });
    expect(auditMessages).toHaveLength(1);
    for (const fragment of [
      "ClawHub Security Audit",
      "Outcome: Safe",
      "No security concerns found in the fixture release.",
      "Details:",
      securityUrl,
    ]) {
      expect(auditMessages[0]).toContain(fragment);
    }
    expect(trust).toEqual({
      ok: true,
      trustInstallRecordFields: {
        clawhubTrustDisposition: "clean",
        clawhubTrustScanStatus: "clean",
        clawhubTrustCheckedAt: expect.any(String),
      },
    });
    const download = await fetch(`${baseUrl}${versionPath}/artifact/download`);
    expect(download.headers.get("x-clawhub-artifact-sha256")).toBe(sha256);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(archive);
    expect((await fetchJson(baseUrl, "/__fixture__/requests")).requests).toEqual(
      completeRequestPaths.map((requestPath) => `GET ${requestPath}`),
    );
    expect(assertRequests().status).toBe(0);
    expectFailure(
      assertRequests("complete", 2),
      "expected 2-16 complete ClawHub artifact audit sequences",
    );
    expectFailure(noRequests(), "unexpected ClawHub fixture requests");
    expectFailure(runAutomaticChecks(), "unexpected ClawHub fixture requests");
    const requestSequence = async (url = baseUrl) => {
      for (const requestPath of completeRequestPaths) {
        const response = await fetch(`${url}${requestPath}`);
        expect(response.status).toBe(200);
        await response.arrayBuffer();
      }
    };
    await requestSequence();
    expect(assertRequests(2).status).toBe(0);
    for (let attempt = 2; attempt < 4; attempt += 1) {
      await requestSequence();
    }
    expect(assertRequests().status).toBe(1);
    const complete = assertRequests("complete", 2);
    expect(complete.status, complete.stderr).toBe(0);
    expect(complete.stdout).toContain("Verified 4 complete ClawHub artifact audit sequence(s).");

    expect((await fetch(`${baseUrl}${whatsappPath}`)).status).toBe(200);
    const partial = assertRequests("complete", 2);
    expect(partial.status).toBe(1);

    expect((await fetch(`${baseUrl}/api/v1/packages/%40openclaw%2Fforeign`)).status).toBe(404);
    for (const requestPath of completeRequestPaths.slice(1, 3)) {
      expect((await fetch(`${baseUrl}${requestPath}`)).status).toBe(200);
    }
    expectFailure(assertRequests("complete", 2), "unexpected ClawHub fixture requests");

    const { baseUrl: maximumBaseUrl } = await startFixtureServer(
      "prepublish-artifacts",
      signal,
      [manifestPath],
      isolatedCwd,
    );
    for (let attempt = 0; attempt < 17; attempt += 1) {
      await requestSequence(maximumBaseUrl);
    }
    expectFailure(
      assertRequests("complete", 2, maximumBaseUrl),
      "expected 2-16 complete ClawHub artifact audit sequences",
    );
    expect((await fetch(`${baseUrl}/api/v1/packages/%40openclaw%2Fai`)).status).toBe(404);
  });

  it("serves separate plugin-family and skill search fixtures", async ({ signal }) => {
    const { baseUrl } = await startFixtureServer("catalog-search", signal);

    for (const [family, score] of [
      ["code-plugin", 4],
      ["bundle-plugin", 12],
    ] as const) {
      const { results } = await fetchJson(
        baseUrl,
        `/api/v1/packages/search?q=calendar&family=${family}&limit=5`,
      );
      expect(results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            score,
            package: expect.objectContaining({ name: "@acme/calendar", family }),
          }),
        ]),
      );
    }

    const skills = await fetchJson(baseUrl, "/api/v1/search?q=calendar&limit=5");
    expect(skills.results).toEqual([
      expect.objectContaining({ score: 99, slug: "calendar-skill" }),
    ]);

    const empty = await fetchJson(
      baseUrl,
      "/api/v1/packages/search?q=empty&family=code-plugin&limit=5",
    );
    expect(empty).toEqual({ results: [] });

    const unavailable = await fetch(
      `${baseUrl}/api/v1/packages/search?q=unavailable&family=code-plugin&limit=5`,
    );
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ error: "catalog unavailable" });
  });
});
