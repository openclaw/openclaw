import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeLauncher } from "./launcher.js";
import {
  createLegacyLauncherFixture,
  legacyLauncherSource,
} from "./legacy-launcher.test-support.js";
import { repairLegacyGitReleaseLauncher } from "./repair-launcher.js";

const dirs = createTempDirTracker();
afterEach(() => {
  vi.restoreAllMocks();
  dirs.cleanup();
});

it.each([
  "modern",
  "custom",
  "other-release",
  "other-state",
  "read-only",
  "foreign-owner",
  "symlink",
])("preserves a %s launcher and its unresolved trial", async (kind) => {
  const state = dirs.make("legacy-launcher-scope-");
  const fixture = createLegacyLauncherFixture(state);
  const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: state };
  let root = fixture.root;
  if (kind === "modern") {
    await writeLauncher(fixture.prefix);
  }
  if (kind === "custom") {
    await fs.appendFile(fixture.launcher, "\n// operator customization\n");
  }
  if (kind === "other-release") {
    root = path.join(fixture.prefix, "releases/previous/openclaw");
  }
  if (kind === "other-state") {
    env.OPENCLAW_STATE_DIR = dirs.make("unrelated-state-");
  }
  if (kind === "read-only") {
    env.OPENCLAW_CONFIG_READONLY = "1";
  }
  if (kind === "foreign-owner") {
    if (!process.getuid) {
      return;
    }
    vi.spyOn(process, "getuid").mockReturnValue(process.getuid() + 1);
  }
  if (kind === "symlink") {
    const custom = path.join(state, "custom-launcher.mjs");
    await fs.rename(fixture.launcher, custom);
    await fs.symlink(custom, fixture.launcher);
  }
  const source = await fs.readFile(fixture.launcher, "utf8");
  expect(await repairLegacyGitReleaseLauncher({ root, env })).toBeNull();
  expect(await fs.readFile(fixture.launcher, "utf8")).toBe(source);
  expect(await fs.readFile(fixture.trial, "utf8")).toBe(fixture.record);
});

it("repairs only once and leaves missing launchers for their installation owner", async () => {
  const state = dirs.make("legacy-launcher-repeat-");
  const fixture = createLegacyLauncherFixture(state);
  const params = { root: fixture.root, env: { OPENCLAW_STATE_DIR: state } };
  expect(await repairLegacyGitReleaseLauncher(params)).toBe(fixture.launcher);
  expect(await fs.readFile(fixture.launcher, "utf8")).not.toBe(legacyLauncherSource);
  expect(await repairLegacyGitReleaseLauncher(params)).toBeNull();
  await fs.unlink(fixture.launcher);
  expect(await repairLegacyGitReleaseLauncher(params)).toBeNull();
  expect(await fs.readFile(fixture.trial, "utf8")).toBe(fixture.record);
});
