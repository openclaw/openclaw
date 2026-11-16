import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { podmanEntrypoints, podmanFixture } from "./podman.test-support.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

it.each(["-h", "--help"])("Podman setup %s works before loading setup dependencies", (flag) => {
  const root = createTempDir("openclaw-podman-help-");
  const { config, run } = podmanFixture(root);
  const result = run(
    podmanEntrypoints.seed,
    { OPENCLAW_REPO_PATH: path.join(root, "missing-repository") },
    [flag],
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Usage:");
  expect(result.stdout).toContain("--quadlet");
  expect(result.stdout).toContain("--container");
  expect(result.stderr).toBe("");
  expect(fs.existsSync(config)).toBe(false);
});

it.each([
  { args: ["--qudalet"] },
  { args: ["unexpected"] },
  { args: ["--container", "--qudalet"] },
])("Podman setup rejects $args before provisioning", ({ args }) => {
  const root = createTempDir("openclaw-podman-arguments-");
  const { config, command, run } = podmanFixture(root);
  const calls = path.join(root, "podman-calls");
  command("podman", 'printf "%s\\n" "$*" >> "$PODMAN_CALLS"\nexit 97');
  const result = run(podmanEntrypoints.seed, { PODMAN_CALLS: calls }, args);
  expect(result.status, result.stderr).toBe(2);
  expect(result.stderr).toContain(`Unknown argument: ${args[args.length - 1]}`);
  expect(result.stderr).toContain("Usage:");
  expect(fs.existsSync(calls)).toBe(false);
  expect(fs.existsSync(config)).toBe(false);
});
