import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { withinTest } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const ASSERTIONS_SCRIPT = "scripts/e2e/lib/kitchen-sink-plugin/assertions.mjs";
const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";
const REQUIRED_FULL_DIAGNOSTIC_CANARIES = [
  "agent tool result middleware must be a function",
  "trusted tool policy registration requires id, description, and evaluate()",
  "plugin must declare contracts.tools for: kitchen-sink-tool",
  'channel "kitchen-sink-channel-probe" registration missing or invalid required capabilities.chatTypes',
  'agent harness "kitchen-sink-agent-harness" registration missing required runtime methods',
  "session scheduler job registration requires unique id, sessionKey, and kind",
];
const WIDGET_PROBE_DIAGNOSTIC = "invalid widget presenter registration";
const WORKER_PROBE_DIAGNOSTIC = "worker provider registration missing method: resolveAllocation";
// A concrete synchronized probe report, not an inventory parsed from the checker.
const SYNCHRONIZED_FULL_DIAGNOSTICS = [
  ...REQUIRED_FULL_DIAGNOSTIC_CANARIES,
  "cli registration missing explicit commands metadata",
  "only bundled plugins can register Codex app-server extension factories",
  'compaction provider "kitchen-sink-compaction-provider" registration missing summarize',
  "context engine registration missing id",
  "control UI descriptor registration requires id, surface, label, and valid optional fields",
  "hosted media resolver registration missing resolver",
  "http route registration missing or invalid auth: /kitchen-sink/http-route",
  WIDGET_PROBE_DIAGNOSTIC,
  "node invoke policy registration missing commands",
  "plugin must declare contracts.embeddingProviders for adapter: kitchen-sink-embedding-provider",
  "memory prompt preparation registration missing prepare function",
  "memory prompt supplement registration missing builder",
  "MCP server connection resolver registration missing serverName or resolve",
  "model catalog provider registration missing provider",
  "session extension registration requires namespace and description",
  "tool metadata registration missing toolName",
  WORKER_PROBE_DIAGNOSTIC,
];

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function fullSurfaceInspectPayload(pluginId: string) {
  const diagnostics: Array<{ level: string; message: string }> = [];
  return {
    commands: ["kitchen"],
    diagnostics,
    plugin: {
      id: pluginId,
      enabled: true,
      status: "loaded",
      contextEngineIds: [pluginId],
      channelIds: ["kitchen-sink-channel"],
      providerIds: ["kitchen-sink-provider"],
      speechProviderIds: ["kitchen-sink-speech"],
      realtimeTranscriptionProviderIds: ["kitchen-sink-realtime-transcription"],
      realtimeVoiceProviderIds: ["kitchen-sink-realtime-voice"],
      mediaUnderstandingProviderIds: ["kitchen-sink-media"],
      imageGenerationProviderIds: ["kitchen-sink-image"],
      videoGenerationProviderIds: ["kitchen-sink-video"],
      musicGenerationProviderIds: ["kitchen-sink-music"],
      webFetchProviderIds: ["kitchen-sink-fetch"],
      webSearchProviderIds: ["kitchen-sink-search"],
      migrationProviderIds: ["kitchen-sink-migration-providers"],
      agentHarnessIds: [],
      hookCount: 30,
    },
    services: ["kitchen-sink-service"],
    tools: [{ names: ["kitchen_sink_text", "kitchen_sink_search", "kitchen_sink_image_job"] }],
    typedHooks: Array.from({ length: 30 }, (_, index) => `hook-${index}`),
  };
}

function expectFailure(
  result: { status: number | null; stdout: string; stderr: string },
  message: string,
  stream = "combined",
) {
  expect(result.status).not.toBe(0);
  expect(stream === "stderr" ? result.stderr : `${result.stdout}\n${result.stderr}`).toContain(
    message,
  );
}

function diagnosticErrors(messages: string[]) {
  return messages.map((message) => ({ level: "error", message }));
}

function runAssertInstalled({
  allInspectPayload,
  diagnostics = [],
  env = {},
  inspectPayload,
  surfaceMode = "full",
  source = "npm",
  installPathRelative,
}: {
  allInspectPayload?: unknown;
  diagnostics?: Array<{ level: string; message: string }>;
  env?: NodeJS.ProcessEnv;
  inspectPayload?: ReturnType<typeof fullSurfaceInspectPayload>;
  surfaceMode?: string;
  source?: "npm" | "clawhub";
  installPathRelative?: string;
} = {}) {
  const { parent, home, scratchRoot } = scanFixture();
  const label = "installed";
  const pluginId = "openclaw-kitchen-sink-fixture";
  const spec = "@openclaw/kitchen-sink@latest";
  const installPath =
    source === "npm"
      ? path.join(parent, "install")
      : home + path.sep + (installPathRelative ?? path.join(".openclaw", "extensions", pluginId));
  mkdirSync(path.join(home, ".openclaw", "extensions"), { recursive: true });
  mkdirSync(installPath, { recursive: true });
  const payload = inspectPayload ?? fullSurfaceInspectPayload(pluginId);
  const writeReport = (suffix: string, value: unknown) =>
    writeJson(path.join(scratchRoot, `kitchen-sink-${label}-${suffix}.json`), value);
  writeReport("plugins", { diagnostics, plugins: [{ id: pluginId, status: "loaded" }] });
  writeReport("inspect", payload);
  writeReport("inspect-all", allInspectPayload ?? [payload]);
  writeJson(path.join(home, ".openclaw", "plugins", "installs.json"), {
    installRecords: {
      [pluginId]: {
        installPath,
        source,
        spec: source === "npm" ? spec : `clawhub:${spec}`,
        resolvedSpec: source === "npm" ? spec : `clawhub:${spec}`,
        resolvedVersion: "1.0.0",
        ...(source === "clawhub"
          ? {
              artifactFormat: "zip",
              artifactKind: "legacy-zip",
              clawhubFamily: "code-plugin",
              clawhubPackage: "@openclaw/kitchen-sink",
              integrity: "sha256-test",
              resolvedAt: 1,
              version: "1.0.0",
            }
          : {}),
      },
    },
  });
  const spawnEnv = { ...process.env };
  delete spawnEnv.KITCHEN_SINK_REQUIRE_ALL_DIAGNOSTICS;
  return spawnSync(process.execPath, [ASSERTIONS_SCRIPT, "assert-installed"], {
    encoding: "utf8",
    env: {
      ...spawnEnv,
      ...env,
      HOME: home,
      OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
      OPENCLAW_CONFIG_PATH: path.join(home, ".openclaw", "openclaw.json"),
      KITCHEN_SINK_ID: pluginId,
      KITCHEN_SINK_LABEL: label,
      KITCHEN_SINK_SOURCE: source,
      KITCHEN_SINK_SPEC: `${source}:${spec}`,
      KITCHEN_SINK_SURFACE_MODE: surfaceMode,
      KITCHEN_SINK_TMP_DIR: scratchRoot,
    },
  });
}

function runScanLogs({
  env = {},
  home,
  scratchRoot,
}: {
  env?: NodeJS.ProcessEnv;
  home: string;
  scratchRoot: string;
}) {
  return spawnSync(process.execPath, [ASSERTIONS_SCRIPT, "scan-logs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      HOME: home,
      KITCHEN_SINK_TMP_DIR: scratchRoot,
    },
  });
}

function runSweepShell(script: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(BASH_BIN, ["-c", toBashScript(script)], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...toBashEnv(env) },
  });
}

async function runSweepShellUntilSettled(
  script: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
) {
  let stdout = "";
  let stderr = "";
  const command = runManagedCommand({
    bin: BASH_BIN,
    args: ["-c", toBashScript(script)],
    cwd: process.cwd(),
    env: { ...process.env, ...toBashEnv(env) },
    stdio: ["ignore", "pipe", "pipe"],
    requireProcessTreeExit: process.platform !== "win32",
    signal,
    onReady(child) {
      child.stdout!.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
    },
  });
  try {
    return { status: await withinTest(command, signal), stdout, stderr };
  } finally {
    // The managed owner joins the shell tree after cancellation before temp files are removed.
    await command.catch(() => {});
  }
}

function toBashScript(script: string) {
  if (process.platform === "win32") {
    return `export PATH="/usr/bin:/bin:$PATH"\n${script}`;
  }
  return script;
}

function toBashEnv(env: NodeJS.ProcessEnv) {
  if (process.platform !== "win32") {
    return env;
  }

  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      typeof value === "string" ? toGitBashPath(value) : value,
    ]),
  );
}

function toGitBashPath(value: string) {
  const match = /^([A-Za-z]):[\\/](.*)$/u.exec(value);
  if (!match) {
    return value;
  }
  const drive = match[1];
  const suffix = match[2];
  if (drive === undefined || suffix === undefined) {
    return value;
  }
  return `/${drive.toLowerCase()}/${suffix.replaceAll("\\", "/")}`;
}

function scanFixture() {
  const parent = tempDirs.make("openclaw-kitchen-sink-scan-");
  const home = path.join(parent, "home");
  const scratchRoot = path.join(parent, "scratch");
  mkdirSync(home, { recursive: true });
  mkdirSync(scratchRoot, { recursive: true });
  return { parent, home, scratchRoot };
}

describe("kitchen-sink plugin assertions", () => {
  it("bounds expected-failure output before matching failure diagnostics", () => {
    const scratchRoot = tempDirs.make("openclaw-kitchen-sink-failure-cap-");
    const outputPath = path.join(scratchRoot, "expected-failure.log");
    writeFileSync(outputPath, "x".repeat(128));

    const result = spawnSync(process.execPath, [ASSERTIONS_SCRIPT, "expect-failure", outputPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        KITCHEN_SINK_EXPECT_FAILURE_OUTPUT_MAX_BYTES: "64",
        KITCHEN_SINK_SOURCE: "npm",
        KITCHEN_SINK_SPEC: "npm:@openclaw/kitchen-sink@0.0.0",
      },
    });

    expectFailure(result, "expected failure output exceeded 64 bytes", "stderr");
  });

  it("fails full-surface installs when stable diagnostic canaries disappear", () => {
    const result = runAssertInstalled();

    expectFailure(result, "missing expected kitchen-sink diagnostic error");
  });

  describe.each([["worker", WORKER_PROBE_DIAGNOSTIC]])(
    "%s probe diagnostics",
    (_probe, diagnostic) => {
      it("requires the rejection in a synchronized exhaustive report", () => {
        const complete = runAssertInstalled({
          diagnostics: diagnosticErrors(SYNCHRONIZED_FULL_DIAGNOSTICS),
          env: { KITCHEN_SINK_REQUIRE_ALL_DIAGNOSTICS: "1" },
        });
        expect(complete.status, complete.stderr).toBe(0);
        const missing = runAssertInstalled({
          diagnostics: diagnosticErrors(
            SYNCHRONIZED_FULL_DIAGNOSTICS.filter((message) => message !== diagnostic),
          ),
          env: { KITCHEN_SINK_REQUIRE_ALL_DIAGNOSTICS: "1" },
        });
        expect(missing.status).not.toBe(0);
        expect(missing.stderr).toContain(
          `missing expected kitchen-sink diagnostic error: ${diagnostic}`,
        );
      });
    },
  );

  it("rejects diagnostics in conformance mode", () => {
    const result = runAssertInstalled({
      diagnostics: diagnosticErrors(["plugin must declare contracts.tools for: kitchen-sink-tool"]),
      surfaceMode: "conformance",
    });

    expectFailure(
      result,
      "unexpected kitchen-sink diagnostic errors: plugin must declare contracts.tools for: kitchen-sink-tool",
      "stderr",
    );
  });

  it("requires kitchen-sink plugins to appear in inspect-all output", () => {
    const result = runAssertInstalled({
      allInspectPayload: [fullSurfaceInspectPayload("other-plugin")],
      diagnostics: diagnosticErrors(REQUIRED_FULL_DIAGNOSTIC_CANARIES),
    });

    expectFailure(result, "kitchen-sink plugin missing from inspect --all output");
  });

  it("fails kitchen-sink inspect-all diagnostics for the installed plugin", () => {
    const inspectPayload = fullSurfaceInspectPayload("openclaw-kitchen-sink-fixture");
    const result = runAssertInstalled({
      allInspectPayload: [
        {
          ...inspectPayload,
          diagnostics: [{ level: "error", message: "inspect-all runtime failed" }],
        },
      ],
      diagnostics: diagnosticErrors(REQUIRED_FULL_DIAGNOSTIC_CANARIES),
    });

    expectFailure(result, "inspect-all runtime failed");
  });

  it("requires the full kitchen-sink tool surface in full mode", () => {
    const inspectPayload = fullSurfaceInspectPayload("openclaw-kitchen-sink-fixture");
    inspectPayload.tools = [{ names: ["kitchen_sink_text"] }];
    const result = runAssertInstalled({
      diagnostics: diagnosticErrors(REQUIRED_FULL_DIAGNOSTIC_CANARIES),
      inspectPayload,
    });

    expectFailure(result, "tools missing kitchen_sink_search");
  });

  it.each(["all"])(
    "retains bounded redacted %s inspection failure details without dumping config",
    () => {
      const root = tempDirs.make("openclaw-inspection-redactor-");
      const redactor = path.join(root, "redactor.mjs");
      const secret = `FIXTURE_SECRET_${"x".repeat(5000)}_END`;
      writeFileSync(
        redactor,
        `export function redactSensitiveText(value, options) {
  if (options.mode !== "tools") throw new Error("wrong redaction mode");
  return value.replace(/FIXTURE_SECRET_.*?_END/gs, "[REDACTED]");
}\n`,
      );
      const healthy = fullSurfaceInspectPayload("openclaw-kitchen-sink-fixture");
      const failed = {
        ...healthy,
        plugin: {
          ...healthy.plugin,
          status: "error",
          error: `loader refused ${secret}; retained cause`,
          source: "/fixture/plugin/index.js",
          config: { privateValue: "DO_NOT_DUMP_CONFIG" },
        },
        diagnostics: [
          { level: "error", message: `registration failed ${secret}; retained diagnostic` },
          ...Array.from({ length: 25 }, (_, index) => ({
            level: "error",
            message: `extra-diagnostic-${index} ${"z".repeat(4096)}`,
          })),
        ],
      };
      const result = runAssertInstalled({
        inspectPayload: healthy,
        allInspectPayload: [failed],
        env: { OPENCLAW_E2E_REDACTOR_MODULE: redactor },
      });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(1);
      expect(output).toContain("expected enabled loaded kitchen-sink plugin");
      expect(output).toContain("loader refused [REDACTED]; retained cause");
      expect(output).toContain("registration failed [REDACTED]; retained diagnostic");
      expect(output).toContain("/fixture/plugin/index.js");
      expect(output).not.toContain("FIXTURE_SECRET_");
      expect(output).not.toContain("DO_NOT_DUMP_CONFIG");
      expect(output).not.toContain("extra-diagnostic-24");
      expect(output.length).toBeLessThan(16 * 1024);
    },
  );

  it("keeps inspection failure details private when the canonical redactor fails", () => {
    const root = tempDirs.make("openclaw-inspection-redactor-");
    const redactor = path.join(root, "redactor.mjs");
    writeFileSync(redactor, 'throw new Error("DO_NOT_DUMP_REDACTOR_ERROR");\n');
    const healthy = fullSurfaceInspectPayload("openclaw-kitchen-sink-fixture");
    const result = runAssertInstalled({
      allInspectPayload: [
        {
          ...healthy,
          plugin: { ...healthy.plugin, status: "error", error: "DO_NOT_DUMP_RAW_ERROR" },
        },
      ],
      env: { OPENCLAW_E2E_REDACTOR_MODULE: redactor },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("inspection details omitted: canonical redaction unavailable");
    expect(result.stderr).not.toContain("DO_NOT_DUMP_RAW_ERROR");
    expect(result.stderr).not.toContain("DO_NOT_DUMP_REDACTOR_ERROR");
  });

  it("rejects ClawHub kitchen-sink install paths that resolve outside managed extensions", () => {
    const result = runAssertInstalled({
      source: "clawhub",
      surfaceMode: "basic",
      installPathRelative: [".openclaw", "extensions", "..", "escaped-kitchen-sink"].join(path.sep),
    });

    expectFailure(result, "kitchen-sink ClawHub install path resolved outside", "stderr");
  });

  it("scans only the configured kitchen-sink scratch root", () => {
    const { parent, home, scratchRoot } = scanFixture();
    const siblingRoot = path.join(parent, "sibling");
    mkdirSync(siblingRoot, { recursive: true });
    writeFileSync(path.join(scratchRoot, "large.log"), `${"x".repeat(70 * 1024)}\n0 errors\n`);
    writeFileSync(path.join(siblingRoot, "stale.log"), "[ERROR] stale sibling failure\n");

    const result = runScanLogs({ home, scratchRoot });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("log scan passed");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("stale sibling failure");
  });

  it("bounds irrelevant OpenClaw home traversal during log scans", () => {
    const { home, scratchRoot } = scanFixture();
    mkdirSync(path.join(home, ".openclaw"), { recursive: true });
    writeFileSync(path.join(scratchRoot, "scenario.log"), "0 errors\n");
    for (let index = 0; index < 20; index += 1) {
      const dir = path.join(home, ".openclaw", `cache-${index}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "state.txt"), "not a log\n");
    }

    const result = runScanLogs({
      env: { KITCHEN_SINK_LOG_SCAN_MAX_ENTRIES: "8" },
      home,
      scratchRoot,
    });

    expectFailure(result, "kitchen-sink log scan exceeded 8 filesystem entries");
  });

  it("does not allow dirty error lines just because they mention zero errors", () => {
    const { home, scratchRoot } = scanFixture();
    writeFileSync(
      path.join(scratchRoot, "dirty.log"),
      "[ERROR] 0 errors reported but fatal state remained\n",
    );

    const result = runScanLogs({ home, scratchRoot });

    expectFailure(result, "unexpected error-like log lines");
    expect(`${result.stdout}\n${result.stderr}`).toContain("fatal state remained");
  });

  it("rejects kitchen-sink log scans that find no files", () => {
    const { home, scratchRoot } = scanFixture();
    const result = runScanLogs({ home, scratchRoot });

    expectFailure(result, "kitchen-sink log scan found no files");
  });

  it("bounds repeated kitchen-sink log scan findings", () => {
    const { home, scratchRoot } = scanFixture();
    writeFileSync(
      path.join(scratchRoot, "errors.log"),
      Array.from({ length: 105 }, (_, index) => `[ERROR] failure ${index}`).join("\n"),
    );

    const result = runScanLogs({ home, scratchRoot });

    expectFailure(result, "additional findings omitted");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("[ERROR] failure 104");
  });

  it("bounds huge single-line kitchen-sink log findings", () => {
    const { home, scratchRoot } = scanFixture();
    writeFileSync(
      path.join(scratchRoot, "single-line.jsonl"),
      `DO_NOT_DUMP_OLD_PREFIX${"x".repeat(256 * 1024)}recent marker [ERROR] bad state`,
    );

    const result = runScanLogs({ home, scratchRoot });

    expectFailure(result, "recent marker");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("DO_NOT_DUMP_OLD_PREFIX");
    expect(`${result.stdout}\n${result.stderr}`.length).toBeLessThan(25 * 1024);
  });

  it("rejects kitchen-sink log scans without an isolated scratch root", () => {
    const parent = tempDirs.make("openclaw-kitchen-sink-scan-");
    const spawnEnv: NodeJS.ProcessEnv = { ...process.env, HOME: parent };
    delete spawnEnv.KITCHEN_SINK_TMP_DIR;
    const result = spawnSync(process.execPath, [ASSERTIONS_SCRIPT, "scan-logs"], {
      encoding: "utf8",
      env: spawnEnv,
    });

    expectFailure(result, "KITCHEN_SINK_TMP_DIR is required");
  });

  it("cleans the default kitchen-sink scratch root", () => {
    const parent = tempDirs.make("openclaw-kitchen-sink-cleanup-");
    const marker = path.join(parent, "scratch-path.txt");
    const result = runSweepShell(
      `
set -euo pipefail
export KITCHEN_SINK_SWEEP_SOURCE_ONLY=1
source scripts/e2e/lib/kitchen-sink-plugin/sweep.sh
printf '%s\\n' "$KITCHEN_SINK_TMP_DIR" > "$MARKER"
test -d "$KITCHEN_SINK_TMP_DIR"
cleanup_kitchen_sink_sweep
test ! -e "$KITCHEN_SINK_TMP_DIR"
`,
      { MARKER: marker },
    );

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const scratchRoot = readFileSync(marker, "utf8").trim();
    expect(scratchRoot).toContain("/tmp/openclaw-kitchen-sink.");
    expect(existsSync(scratchRoot)).toBe(false);
  });

  it("includes expected-failure transcripts in the final kitchen-sink log scan", () => {
    const parent = tempDirs.make("openclaw-kitchen-sink-failure-log-");
    const home = path.join(parent, "home");
    const scratchRoot = path.join(parent, "scratch");
    mkdirSync(home, { recursive: true });
    mkdirSync(scratchRoot, { recursive: true });

    const result = runSweepShell(
      `
set -euo pipefail
export HOME="$HOME_DIR"
export KITCHEN_SINK_SWEEP_SOURCE_ONLY=1
export KITCHEN_SINK_TMP_DIR="$SCRATCH_ROOT"
export KITCHEN_SINK_SOURCE=npm
export KITCHEN_SINK_SPEC=npm:@openclaw/kitchen-sink@0.0.0
source scripts/e2e/lib/kitchen-sink-plugin/sweep.sh
run_expect_failure "install/failure" bash -c 'printf "%s\\n" "npm ERR! No matching version @openclaw/kitchen-sink@0.0.0"; exit 1'
test -f "$SCRATCH_ROOT/kitchen-sink-expected-failure-install_failure.log"
node scripts/e2e/lib/kitchen-sink-plugin/assertions.mjs scan-logs
`,
      {
        HOME_DIR: home,
        SCRATCH_ROOT: scratchRoot,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("log scan passed");
  });

  it("cleans a ClawHub fixture server that times out before readiness", () => {
    const parent = tempDirs.make("openclaw-kitchen-sink-clawhub-");
    const fakeBin = path.join(parent, "bin");
    const scratchRoot = path.join(parent, "scratch");
    const fixtureDir = path.join(scratchRoot, "clawhub-fixture");
    const nodeShim = path.join(fakeBin, "node");
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(nodeShim, "#!/usr/bin/env bash\nsleep 30\n");
    chmodSync(nodeShim, 0o755);

    const result = runSweepShell(
      `
set -euo pipefail
export PATH="$FAKE_BIN:$PATH"
export KITCHEN_SINK_SWEEP_SOURCE_ONLY=1
export KITCHEN_SINK_TMP_DIR="$SCRATCH_ROOT"
export OPENCLAW_CLAWHUB_FIXTURE_WAIT_ATTEMPTS=1
source scripts/e2e/lib/kitchen-sink-plugin/sweep.sh
set +e
start_kitchen_sink_clawhub_fixture_server "$FIXTURE_DIR"
status="$?"
set -e
if [[ "$status" -eq 0 ]]; then
  echo "fixture unexpectedly became ready" >&2
  exit 1
fi
server_pid="$(cat "$FIXTURE_DIR/clawhub-fixture-pid")"
kill -0 "$server_pid"
cleanup_kitchen_sink_sweep
if kill -0 "$server_pid" 2>/dev/null; then
  echo "fixture server still running after cleanup" >&2
  exit 1
fi
test ! -e "$FIXTURE_DIR"
test -d "$SCRATCH_ROOT"
`,
      {
        FAKE_BIN: fakeBin,
        FIXTURE_DIR: fixtureDir,
        SCRATCH_ROOT: scratchRoot,
      },
    );

    expect(result.status).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "Timed out waiting for kitchen-sink ClawHub fixture server.",
    );
    expect(existsSync(fixtureDir)).toBe(false);
    expect(existsSync(scratchRoot)).toBe(true);
  });

  it("bounds ClawHub fixture server logs on startup timeout", async ({
    signal,
    onTestFinished,
  }) => {
    const parent = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-sink-clawhub-log-"));
    const fakeBin = path.join(parent, "bin");
    const scratchRoot = path.join(parent, "scratch");
    const fixtureDir = path.join(scratchRoot, "clawhub-fixture");
    const nodeShim = path.join(fakeBin, "node");
    const sleepShim = path.join(fakeBin, "sleep");
    const fixtureReadyPath = path.join(parent, "fixture-log-ready");
    let command: ReturnType<typeof runSweepShellUntilSettled> | undefined;
    let cleanup: Promise<void> | undefined;
    const close = () =>
      (cleanup ??= (async () => {
        await command?.catch(() => {});
        rmSync(parent, { force: true, recursive: true });
      })());
    onTestFinished(close);
    try {
      mkdirSync(fakeBin, { recursive: true });
      mkdirSync(fixtureDir, { recursive: true });
      writeFileSync(
        nodeShim,
        [
          "#!/usr/bin/env bash",
          "printf 'DO_NOT_DUMP_CLAWHUB_PREFIX\\n'",
          "head -c 2048 /dev/zero | tr '\\0' x",
          "printf '\\nFIXTURE_TAIL_MARKER\\n'",
          'printf "ready\\n" >&3',
          "exec /bin/sleep 30",
          "",
        ].join("\n"),
      );
      chmodSync(nodeShim, 0o755);
      writeFileSync(
        sleepShim,
        [
          "#!/usr/bin/env bash",
          "read -r ready <&3",
          '[[ "$ready" == ready ]] || exit 1',
          "# Startup and cleanup share this shim, so keep readiness available for every call.",
          'printf "%s\\n" "$ready" >&3',
          "",
        ].join("\n"),
      );
      chmodSync(sleepShim, 0o755);

      command = runSweepShellUntilSettled(
        `
set -euo pipefail
mkfifo "$FIXTURE_READY_PATH"
exec 3<>"$FIXTURE_READY_PATH"
export PATH="$FAKE_BIN:$PATH"
export KITCHEN_SINK_SWEEP_SOURCE_ONLY=1
export KITCHEN_SINK_TMP_DIR="$SCRATCH_ROOT"
export OPENCLAW_CLAWHUB_FIXTURE_WAIT_ATTEMPTS=1
export OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES=64
source scripts/e2e/lib/kitchen-sink-plugin/sweep.sh
set +e
start_kitchen_sink_clawhub_fixture_server "$FIXTURE_DIR"
status="$?"
set -e
cleanup_kitchen_sink_sweep
exit "$status"
`,
        {
          FAKE_BIN: fakeBin,
          FIXTURE_DIR: fixtureDir,
          FIXTURE_READY_PATH: fixtureReadyPath,
          SCRATCH_ROOT: scratchRoot,
        },
        signal,
      );
      const result = await command;

      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("truncated: showing last 64");
      expect(result.stdout).toContain("FIXTURE_TAIL_MARKER");
      expect(result.stdout).not.toContain("DO_NOT_DUMP_CLAWHUB_PREFIX");
    } finally {
      await close();
    }
  });
});
