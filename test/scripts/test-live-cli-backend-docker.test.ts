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
  for (const target of "scripts/test-live-build-docker.sh bin/docker bin/node bin/timeout".split(
    " ",
  )) {
    symlinkSync("/usr/bin/true", path.join(root, target));
  }
  const result = spawnSync("/bin/bash", ["-x", SCRIPT_PATH], {
    encoding: "utf8",
    env: {
      HOME: path.join(root, "home"),
      PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
      OPENCLAW_LIVE_DOCKER_TRUSTED_HARNESS_DIR: root,
      ...Object.fromEntries(controls.map((key) => [key, "forwarded"])),
    },
  });
  expect(result.status).toBe(0);
  for (const key of controls) {
    expect(result.stderr).toContain(`${key}=forwarded`);
  }
});

it("passes only subscription credentials to a Claude subscription container", () => {
  const root = createTempDir("openclaw-live-cli-subscription-");
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
      OPENCLAW_LIVE_CLI_BACKEND_AUTH: "subscription",
      CLAUDE_CODE_OAUTH_TOKEN: "synthetic-subscription-token",
      ANTHROPIC_API_KEY: "synthetic-api-key",
    },
  });

  expect(result.status, result.stderr).toBe(0);
  const argv = readFileSync(capture, "utf8").split("\0");
  const forwardedEnv = argv.flatMap((arg, index) => (arg === "-e" ? [argv[index + 1]] : []));
  expect(forwardedEnv).toContain("CLAUDE_CODE_OAUTH_TOKEN=synthetic-subscription-token");
  expect(forwardedEnv).not.toContain("ANTHROPIC_API_KEY");
  expect(forwardedEnv).not.toContain("ANTHROPIC_API_KEY=synthetic-api-key");
});
