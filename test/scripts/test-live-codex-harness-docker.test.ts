import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

const scriptsDir = path.resolve(import.meta.dirname, "../../scripts");
const SCRIPT_PATH = path.join(scriptsDir, "test-live-codex-harness-docker.sh");
const script = fs.readFileSync(SCRIPT_PATH, "utf8");
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
      expect(
        forwardedEnv.find((value) => value?.startsWith("OPENCLAW_LIVE_CODEX_CLI_PACKAGE_SPEC=")),
      ).toMatch(/^OPENCLAW_LIVE_CODEX_CLI_PACKAGE_SPEC=@openai\/codex@\d[^\s*]*$/u);
      const mounts = argv.flatMap((arg, index) => (arg === "-v" ? [argv[index + 1]] : []));
      expect(
        mounts
          .filter((mount) => mount?.startsWith(baseEnv.RUNNER_TEMP + "/"))
          .map((mount) => mount?.split(":")[1]),
      ).toEqual(["/home/node", "/home/node/.openclaw", "/home/node/.openclaw/workspace"]);
      expect(forwardedEnv).toContain(
        `OPENCLAW_LIVE_CODEX_HARNESS_REQUEST_TIMEOUT_MS=${env.OPENCLAW_LIVE_CODEX_HARNESS_REQUEST_TIMEOUT_MS ?? ""}`,
      );
    }
  });

  it("pins CLI installation and bounds failed-preflight diagnostics", () => {
    expect(script).toContain(
      'run_setup_command npm install -g "$OPENCLAW_LIVE_CODEX_CLI_PACKAGE_SPEC"',
    );
    expect(script).toMatch(/tail -c \d+ "\$codex_preflight_log"/u);
    expect(script).not.toContain('cat "$codex_preflight_log"');
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

  it.each<[NodeJS.ProcessEnv, number, string]>([
    [{ OPENCLAW_LIVE_CODEX_HARNESS_SETUP_TIMEOUT_SECONDS: "180s" }, 2, "invalid"],
    [{ OPENCLAW_LIVE_CODEX_HARNESS_AUTH: "api-key" }, 1, "requires OPENAI_API_KEY"],
    [{ OPENCLAW_LIVE_CODEX_HARNESS_AUTH: "codex-auth" }, 1, "requires ~/.codex/auth.json"],
  ])("rejects missing auth or invalid setup before Docker: %j", (env, status, error) => {
    const result = runBash([SCRIPT_PATH], {
      PATH: process.env.PATH,
      HOME: createTempDir("openclaw-codex-preflight-"),
      ...env,
    });
    expect(result).toMatchObject({ status, stderr: expect.stringContaining(error) });
    expect(result.stdout).not.toContain("Run Codex harness live test in Docker");
  });
});
