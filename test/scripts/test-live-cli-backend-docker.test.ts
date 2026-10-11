import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";
const SCRIPT_PATH = path.resolve("scripts/test-live-cli-backend-docker.sh");
const { createTempDir } = createScriptTestHarness();
it("validates setup early and forwards argument overrides into Docker", () => {
  const invalid = spawnSync("/bin/bash", [SCRIPT_PATH], {
    encoding: "utf8",
    env: { ...process.env, OPENCLAW_LIVE_CLI_BACKEND_SETUP_TIMEOUT_SECONDS: "180s" },
  });
  expect(invalid.status).toBe(2);
  expect(invalid.stderr).toContain("invalid OPENCLAW_LIVE_CLI_BACKEND_SETUP_TIMEOUT_SECONDS: 180s");
  expect(invalid.stderr).not.toMatch(/Cannot find package 'tsx'|docker/);
  const root = createTempDir("openclaw-live-cli-capture-");
  const controls = [
    "OPENCLAW_LIVE_CLI_BACKEND_ARGS",
    "OPENCLAW_LIVE_CLI_BACKEND_RESUME_ARGS",
    "OPENCLAW_TEST_CONSOLE",
    "OPENCLAW_LIVE_CLI_BACKEND_CACHE_PROBE",
    "OPENCLAW_LIVE_CLI_BACKEND_ADVISORY",
    "OPENCLAW_LIVE_CLI_BACKEND_ALLOW_PROVIDER_SKIP",
  ];
  for (const dir of ["scripts", "bin", "home"]) {
    mkdirSync(path.join(root, dir));
  }
  symlinkSync(path.resolve("scripts/lib"), path.join(root, "scripts/lib"));
  for (const target of ["scripts/test-live-build-docker.sh", "bin/node"]) {
    symlinkSync("/usr/bin/true", path.join(root, target));
  }
  const capture = path.join(root, "docker-args");
  writeFileSync(path.join(root, "bin/docker"), '#!/bin/bash\nprintf "%s\\0" "$@" >"$CAPTURE"\n', {
    mode: 0o755,
  });
  writeFileSync(
    path.join(root, "bin/timeout"),
    '#!/bin/bash\nif [[ "$1" = --kill-after=1s ]]; then exit 0; fi\nshift 2\nexec "$@"\n',
    { mode: 0o755 },
  );
  const result = spawnSync("/bin/bash", [SCRIPT_PATH], {
    encoding: "utf8",
    env: {
      HOME: path.join(root, "home"),
      PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
      CAPTURE: capture,
      OPENCLAW_LIVE_DOCKER_TRUSTED_HARNESS_DIR: root,
      OPENCLAW_LIVE_CLI_BACKEND_MODEL: "claude-cli/fixture",
      ...Object.fromEntries(controls.map((key) => [key, "forwarded"])),
    },
  });
  expect(result.status, result.stderr).toBe(0);
  const argv = readFileSync(capture, "utf8").split("\0");
  expect(argv[0]).toBe("run");
  const forwardedEnv = argv.flatMap((arg, index) => (arg === "-e" ? [argv[index + 1]] : []));
  for (const key of controls) {
    expect(forwardedEnv).toContain(`${key}=forwarded`);
  }
  expect(forwardedEnv.filter((value) => value?.startsWith("OPENCLAW_LIVE_CLI_BACKEND_"))).toEqual([
    "OPENCLAW_LIVE_CLI_BACKEND_SETUP_TIMEOUT_SECONDS=180",
    "OPENCLAW_LIVE_CLI_BACKEND_DEBUG=",
    "OPENCLAW_LIVE_CLI_BACKEND_ADVISORY=forwarded",
    "OPENCLAW_LIVE_CLI_BACKEND_ALLOW_PROVIDER_SKIP=forwarded",
    "OPENCLAW_LIVE_CLI_BACKEND_MODEL=claude-cli/fixture",
    "OPENCLAW_LIVE_CLI_BACKEND_COMMAND=",
    "OPENCLAW_LIVE_CLI_BACKEND_ARGS=forwarded",
    "OPENCLAW_LIVE_CLI_BACKEND_RESUME_ARGS=forwarded",
    "OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV=",
    "OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0",
    "OPENCLAW_LIVE_CLI_BACKEND_CACHE_PROBE=forwarded",
    "OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=",
    "OPENCLAW_LIVE_CLI_BACKEND_MODEL_SWITCH_PROBE=0",
    "OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=0",
    "OPENCLAW_LIVE_CLI_BACKEND_MCP_PROBE=0",
    "OPENCLAW_LIVE_CLI_BACKEND_MCP_SCHEMA_PROBE=",
    "OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG=",
    "OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE=",
    "OPENCLAW_LIVE_CLI_BACKEND_AUTH=auto",
    "OPENCLAW_LIVE_CLI_BACKEND_ANTHROPIC_API_KEY=",
    "OPENCLAW_LIVE_CLI_BACKEND_ANTHROPIC_API_KEY_OLD=",
    "OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV=",
  ]);
});
