// Restart Mac tests cover restart mac script behavior.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const helperPath = "scripts/lib/restart-mac-gateway.sh";
const restartScriptPath = "scripts/restart-mac.sh";
const tempRoots: string[] = [];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runGatewayPortCheck(fakeLsof: string) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-restart-mac-test-"));
  tempRoots.push(root);

  const binDir = join(root, "bin");
  mkdirSync(binDir);
  const lsofPath = join(binDir, "lsof");
  writeFileSync(lsofPath, fakeLsof);
  chmodSync(lsofPath, 0o755);

  return spawnSync(
    "bash",
    ["-c", `source ${shellQuote(helperPath)}; verify_gateway_port_listening 18789`],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    },
  );
}

function runCleanupFunction(fakePgrep: string) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-restart-mac-test-"));
  tempRoots.push(root);

  const binDir = join(root, "bin");
  mkdirSync(binDir);
  for (const [name, body] of [
    ["pgrep", fakePgrep],
    ["pkill", "#!/usr/bin/env bash\nexit 0\n"],
    ["sleep", "#!/usr/bin/env bash\nexit 0\n"],
  ] as const) {
    const toolPath = join(binDir, name);
    writeFileSync(toolPath, body);
    chmodSync(toolPath, 0o755);
  }

  const script = readFileSync(restartScriptPath, "utf8");
  const cleanupFunction = script.slice(
    script.indexOf("kill_all_openclaw()"),
    script.indexOf("stop_launch_agent()"),
  );
  const harnessPath = join(root, "cleanup-harness.sh");
  writeFileSync(
    harnessPath,
    [
      "#!/usr/bin/env bash",
      cleanupFunction,
      'APP_PROCESS_PATTERN="OpenClaw.app/Contents/MacOS/OpenClaw"',
      'DEBUG_PROCESS_PATTERN="/worktree/apps/macos/.build/debug/OpenClaw"',
      'LOCAL_PROCESS_PATTERN="/worktree/apps/macos/.build-local/debug/OpenClaw"',
      'RELEASE_PROCESS_PATTERN="/worktree/apps/macos/.build/release/OpenClaw"',
      "kill_all_openclaw",
    ].join("\n"),
  );
  chmodSync(harnessPath, 0o755);

  return spawnSync("bash", [harnessPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("scripts/restart-mac.sh", () => {
  it("fails the gateway verification when lsof finds no listener", () => {
    const result = runGatewayPortCheck("#!/usr/bin/env bash\nexit 1\n");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No process is listening on gateway port 18789.");
    expect(result.stdout).toBe("");
  });

  it("prints listener diagnostics when the gateway port is open", () => {
    const result = runGatewayPortCheck(
      [
        "#!/usr/bin/env bash",
        "printf '%s\\n' 'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME'",
        "printf '%s\\n' 'node    12345 user   21u  IPv4 0x123      0t0  TCP 127.0.0.1:18789 (LISTEN)'",
      ].join("\n"),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("127.0.0.1:18789 (LISTEN)");
    expect(result.stderr).toBe("");
  });

  it("uses a fail-closed gateway port verification helper", () => {
    const script = readFileSync(restartScriptPath, "utf8");

    expect(script).toContain('source "${ROOT_DIR}/scripts/lib/restart-mac-gateway.sh"');
    expect(script).toContain(
      'run_step "verify gateway port ${GATEWAY_PORT} (unsigned)" verify_gateway_port_listening "${GATEWAY_PORT}"',
    );
    expect(script).not.toContain("lsof -iTCP:${GATEWAY_PORT} -sTCP:LISTEN | head -n 5 || true");
  });

  it("keeps the default restart log scoped to the current worktree lock", () => {
    const script = readFileSync(restartScriptPath, "utf8");

    expect(script).toContain(
      'LOG_PATH="${OPENCLAW_RESTART_LOG:-${TMPDIR:-/tmp}/openclaw-restart-${LOCK_KEY}.log}"',
    );
    expect(script).not.toContain('LOG_PATH="${OPENCLAW_RESTART_LOG:-/tmp/openclaw-restart.log}"');
  });

  it("prefers the freshly packaged app unless an explicit app bundle is set", () => {
    const script = readFileSync(restartScriptPath, "utf8");
    const chooseBlock = script.slice(
      script.indexOf("choose_app_bundle()"),
      script.indexOf("choose_app_bundle", script.indexOf("choose_app_bundle()") + 1),
    );

    expect(chooseBlock).toContain('fail "OPENCLAW_APP_BUNDLE does not exist: ${APP_BUNDLE}"');
    expect(chooseBlock.indexOf("${ROOT_DIR}/dist/OpenClaw.app")).toBeGreaterThan(-1);
    expect(chooseBlock.indexOf("/Applications/OpenClaw.app")).toBeGreaterThan(-1);
    expect(chooseBlock.indexOf("${ROOT_DIR}/dist/OpenClaw.app")).toBeLessThan(
      chooseBlock.indexOf("/Applications/OpenClaw.app"),
    );
  });

  it("keeps restart cleanup scoped to known OpenClaw app and build paths", () => {
    const script = readFileSync(restartScriptPath, "utf8");
    const cleanupBlock = script.slice(
      script.indexOf("kill_all_openclaw()"),
      script.indexOf("stop_launch_agent()"),
    );

    expect(cleanupBlock).toContain('pkill -f "${APP_PROCESS_PATTERN}"');
    expect(cleanupBlock).toContain('pkill -f "${DEBUG_PROCESS_PATTERN}"');
    expect(cleanupBlock).toContain('pkill -f "${LOCAL_PROCESS_PATTERN}"');
    expect(cleanupBlock).toContain('pkill -f "${RELEASE_PROCESS_PATTERN}"');
    expect(cleanupBlock).not.toContain('pkill -x "OpenClaw"');
    expect(cleanupBlock).not.toContain('pgrep -x "OpenClaw"');
  });

  it("stops launchd supervision before killing app processes", () => {
    const script = readFileSync(restartScriptPath, "utf8");
    const stopIndex = script.indexOf("stop_launch_agent\nlog");
    const killIndex = script.indexOf("if ! kill_all_openclaw");

    expect(stopIndex).toBeGreaterThan(-1);
    expect(killIndex).toBeGreaterThan(-1);
    expect(stopIndex).toBeLessThan(killIndex);
  });

  it("fails restart cleanup when scoped processes survive every kill attempt", () => {
    const result = runCleanupFunction("#!/usr/bin/env bash\nexit 0\n");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("passes restart cleanup when scoped processes are gone", () => {
    const result = runCleanupFunction("#!/usr/bin/env bash\nexit 1\n");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});
