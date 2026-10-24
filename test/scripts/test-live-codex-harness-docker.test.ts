import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

const scriptsDir = path.resolve(import.meta.dirname, "../../scripts");
const SCRIPT_PATH = path.join(scriptsDir, "test-live-codex-harness-docker.sh");
const script = fs.readFileSync(SCRIPT_PATH, "utf8");
const harnessPrefix = "OPENCLAW_LIVE_CODEX_HARNESS_";
function expectContains(source: string, values: string[], present = true) {
  for (const value of values) {
    expect(source.includes(value), value).toBe(present);
  }
}
const harnessArgs = (values: string) => values.split(/\s+/u).map((value) => harnessPrefix + value);
const runBash = (args: string[], env: NodeJS.ProcessEnv, shell = "bash") =>
  spawnSync(shell, args, { encoding: "utf8", env });

describe("scripts/test-live-codex-harness-docker.sh", () => {
  it("delivers native V2 subagent defaults and preserves explicit app-server arguments", () => {
    const root = createTempDir("openclaw-codex-native-args-");
    for (const dir of ["scripts", "bin", "home", "runtime"]) {
      fs.mkdirSync(path.join(root, dir));
    }
    fs.symlinkSync(path.join(scriptsDir, "lib"), path.join(root, "scripts/lib"));
    const executable = (file: string, body: string) =>
      fs.writeFileSync(path.join(root, file), `#!/bin/bash\n${body}`, { mode: 0o755 });
    executable("scripts/test-live-build-docker.sh", "exit 0\n");
    executable(
      "bin/docker",
      `case "$1" in
  info) printf '["name=seccomp"]\\n' ;;
  run) printf '%s\\0' "$@" >"$CAPTURE" ;;
esac
`,
    );
    const nativeV2Args = "app-server --listen stdio:// -c features.multi_agent_v2=true";
    const explicitArgs = 'app-server --listen stdio:// -c model="caller model"';
    const cases: Array<[Record<string, string>, string]> = [
      [{}, nativeV2Args],
      [{ OPENCLAW_LIVE_CODEX_HARNESS_SUBAGENT_PROBE: "yes" }, nativeV2Args],
      [{ OPENCLAW_LIVE_CODEX_HARNESS_SUBAGENT_PROBE: "0" }, ""],
      [
        {
          OPENCLAW_CODEX_APP_SERVER_ARGS: explicitArgs,
          OPENCLAW_LIVE_CODEX_HARNESS_IMAGE_PROBE: "",
          OPENCLAW_LIVE_CODEX_HARNESS_REQUEST_TIMEOUT_MS: "quoted value = 'ok'",
        },
        explicitArgs,
      ],
    ];
    const capture = path.join(root, "docker-args");
    const baseEnv = {
      HOME: path.join(root, "home"),
      PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
      RUNNER_TEMP: path.join(root, "runtime"),
      CI: "true",
      CAPTURE: capture,
      OPENAI_API_KEY: "test-openai-key",
      OPENCLAW_LIVE_CODEX_HARNESS_AUTH: "api-key",
      OPENCLAW_LIVE_DOCKER_TRUSTED_HARNESS_DIR: root,
    };
    for (const [env, expected] of cases) {
      const result = runBash([SCRIPT_PATH], { ...baseEnv, ...env }, "/bin/bash");
      expect(result.status, result.stderr).toBe(0);
      const argv = fs.readFileSync(capture, "utf8").split("\0");
      expect(argv[0]).toBe("run");
      const forwardedEnv = argv.flatMap((arg, index) => (arg === "-e" ? [argv[index + 1]] : []));
      expect(forwardedEnv).toContain(`OPENCLAW_CODEX_APP_SERVER_ARGS=${expected}`);
      expect(forwardedEnv.filter((value) => value?.startsWith(harnessPrefix))).toEqual([
        ...harnessArgs(`AUTH=api-key CHAT_IMAGE_PROBE=0 CODE_MODE_ONLY=0
COMPACTION_STRESS=0 COMPACTION_STRESS_TURNS=4 DEBUG= DISABLE_LOOP_RELAY=0
GUARDIAN_PROBE=1 IMAGE_PROBE=1 LARGE_OUTPUT_BYTES=300000 MCP_PROBE=1 MULTI_SESSION_PROBE=0
MODEL=openai/gpt-5.6-luna TARGETS= THINKING=low EXPECTED_EFFORT= REQUIRE_GUARDIAN_EVENTS=1`),
        `${harnessPrefix}REQUEST_TIMEOUT_MS=${env.OPENCLAW_LIVE_CODEX_HARNESS_REQUEST_TIMEOUT_MS ?? ""}`,
        ...harnessArgs(`RESUME_STRESS=0 RESUME_STRESS_HISTORY_TURNS=4 RESUME_STRESS_RESTARTS=3
SETUP_TIMEOUT_SECONDS=180 SUBAGENT_ONLY= SUBAGENT_COUNT=1`),
        `${harnessPrefix}SUBAGENT_PROBE=${env.OPENCLAW_LIVE_CODEX_HARNESS_SUBAGENT_PROBE ?? "1"}`,
        `${harnessPrefix}USE_CI_SAFE_CODEX_CONFIG=1`,
      ]);
      expect(forwardedEnv.filter((value) => value?.startsWith("OPENCLAW_LIVE_CODEX_BIND"))).toEqual(
        ["", "_MODEL", "_PROVIDER", "_REQUEST_TIMEOUT_MS", "_TIMEOUT_MS"].map(
          (suffix) => `OPENCLAW_LIVE_CODEX_BIND${suffix}=`,
        ),
      );
    }
  });

  it("retains the Codex auth, isolation, forwarding, and diagnostic contracts", () => {
    expectContains(script, [
      'DOCKER_CACHE_CONTAINER_DIR="/tmp/openclaw-cache"',
      'DOCKER_CLI_TOOLS_CONTAINER_DIR="/tmp/openclaw-npm-global"',
      "openclaw_live_init_cli_tools_dir",
      "openclaw_live_init_cache_home_dir",
      '-e XDG_CACHE_HOME="$DOCKER_CACHE_CONTAINER_DIR"',
      '-e NPM_CONFIG_PREFIX="$DOCKER_CLI_TOOLS_CONTAINER_DIR"',
      "if openclaw_live_uses_managed_bind_dirs; then",
      '-v "$CACHE_HOME_DIR":"$DOCKER_CACHE_CONTAINER_DIR"',
      '-v "$CLI_TOOLS_DIR":"$DOCKER_CLI_TOOLS_CONTAINER_DIR"',
      "OPENCLAW_LIVE_CODEX_HARNESS_AUTH=codex-auth requires ~/.codex/auth.json before building the live Docker image",
      "If this is a Testbox/API-key run, set OPENCLAW_LIVE_CODEX_HARNESS_AUTH=api-key and run through openclaw-testbox-env.",
      "printf 'OPENAI_API_KEY=%s\\n' \"${OPENAI_API_KEY}\"",
      "printf 'CODEX_API_KEY=%s\\n' \"${CODEX_API_KEY:-$OPENAI_API_KEY}\"",
      "openclaw_live_init_managed_home",
      'if [[ "$CODEX_HARNESS_AUTH_MODE" == "api-key" ]]; then',
      'if [[ -z "${DOCKER_HOME_DIR:-}" ]]; then',
      'DOCKER_HOME_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/openclaw-docker-home.XXXXXX")"',
      'CONFIG_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/openclaw-docker-config.XXXXXX")"',
      'WORKSPACE_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/openclaw-docker-workspace.XXXXXX")"',
      'DOCKER_CACHE_CONTAINER_DIR="/home/node/.cache"',
      'DOCKER_CLI_TOOLS_CONTAINER_DIR="/home/node/.npm-global"',
      'PROFILE_STATUS="api-key-env"',
      'chmod 0777 "$DOCKER_HOME_DIR" "$CONFIG_DIR" "$WORKSPACE_DIR" || true',
      'if [[ "$CODEX_HARNESS_AUTH_MODE" != "api-key" ]]; then',
      "cleanup_codex_live_mounts() {",
      'chmod -R a+rwX "$HOME" "$NPM_CONFIG_PREFIX" "$XDG_CACHE_HOME" 2>/dev/null || true',
      "trap cleanup_codex_live_mounts EXIT",
      '"$ROOT_DIR/extensions/codex/package.json"',
      "process.stdout.write(`@openai/codex@${version}`);",
      '-e OPENCLAW_LIVE_CODEX_CLI_PACKAGE_SPEC="$CODEX_CLI_PACKAGE_SPEC"',
      'run_setup_command npm install -g "$OPENCLAW_LIVE_CODEX_CLI_PACKAGE_SPEC"',
      "Failed to extract accountId from token",
      "ERROR: Codex auth cannot extract accountId from the available token; refresh OPENCLAW_CODEX_AUTH_JSON or use OPENCLAW_LIVE_CODEX_HARNESS_AUTH=api-key.",
      'tail -c 262144 "$codex_preflight_log"',
    ]);
    expectContains(fs.readFileSync(path.join(scriptsDir, "lib/live-docker-auth.sh"), "utf8"), [
      "openclaw_live_is_ci",
      'DOCKER_USER="$(id -u):$(id -g)"',
      'openclaw_live_prepare_bind_dir_for_container_user "$CLI_TOOLS_DIR"',
      'openclaw_live_prepare_bind_dir_for_container_user "$CACHE_HOME_DIR"',
    ]);
    expectContains(
      script,
      [
        '-v "$CACHE_HOME_DIR":/home/node/.cache',
        '-v "$CLI_TOOLS_DIR":/home/node/.npm-global',
        'DOCKER_USER="0:0"',
        "run_setup_command npm install -g @openai/codex",
        "SKIP: Codex auth cannot extract accountId",
        'cat "$codex_preflight_log"',
      ],
      false,
    );
    for (const [before, after] of [
      ["requires ~/.codex/auth.json before building", 'OPENCLAW_LIVE_DOCKER_REPO_ROOT="$ROOT_DIR"'],
      ["OPENAI_API_KEY=%s", "CODEX_API_KEY=%s"],
      ['PROFILE_STATUS="api-key-env"', "openclaw_live_append_array DOCKER_RUN_ARGS PROFILE_MOUNT"],
      ["cleanup_codex_live_mounts()", 'mkdir -p "$NPM_CONFIG_PREFIX" "$XDG_CACHE_HOME"'],
    ] as const) {
      expect(script.indexOf(before)).toBeLessThan(script.indexOf(after));
    }
    expect(script).not.toMatch(/Failed to extract accountId from token[\s\S]{0,180}exit 0/u);
  });

  it("keeps the staged Gateway and Codex plugin on the same source module graph", () => {
    const selection = script
      .split('openclaw_live_link_runtime_tree "$tmp_dir"\n')[1]
      ?.split('openclaw_live_stage_state_dir "$tmp_dir/.openclaw-state"')[0];
    expect(selection).toBeDefined();

    const root = createTempDir("openclaw-codex-plugin-roots-");
    const stagedRoot = path.join(root, "staged");
    const stagedPlugin = path.join(stagedRoot, "extensions", "codex");
    fs.mkdirSync(stagedPlugin, { recursive: true });
    fs.writeFileSync(path.join(stagedPlugin, "openclaw.plugin.json"), "{}");
    fs.mkdirSync(path.join(root, "dist-runtime", "extensions", "codex"), { recursive: true });
    const executableSelection = selection!
      .replaceAll("/app/dist-runtime", path.join(root, "dist-runtime"))
      .replaceAll("/app/dist", path.join(root, "dist"));
    const result = runBash(
      ["-c", `${executableSelection}\nprintf '%s' "$OPENCLAW_BUNDLED_PLUGINS_DIR"`],
      { ...process.env, tmp_dir: stagedRoot },
    );

    expect(result).toMatchObject({ status: 0, stdout: path.join(stagedRoot, "extensions") });
  });

  it("rejects invalid setup timeout values before auth or Docker setup", () => {
    const result = runBash([SCRIPT_PATH], {
      ...process.env,
      OPENCLAW_LIVE_CODEX_HARNESS_SETUP_TIMEOUT_SECONDS: "180s",
    });

    expect(result).toMatchObject({
      status: 2,
      stderr: expect.stringContaining(`invalid ${harnessPrefix}SETUP_TIMEOUT_SECONDS: 180s`),
    });
    expectContains(result.stderr, ["requires ~/.codex/auth.json", "docker"], false);
  });
});
