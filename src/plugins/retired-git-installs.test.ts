import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  updateConfigMachineState,
  writeConfigMachineState,
} from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  cleanupRetiredGitPluginInstalls,
  collectConfiguredPluginReferencePaths,
  hasRetiredGitPluginInstallCandidates,
  rememberRetiredGitPluginInstall,
  RETIRED_GIT_INSTALLS_STATE_KEY,
} from "./retired-git-installs.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

function retiredCheckout() {
  const stateDir = tempDirs.make("openclaw-retired-git-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const repo = path.join(stateDir, "git", "git-old", "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "kept.txt"), "old");
  return {
    env,
    repo,
    parentDir: path.dirname(repo),
    replacement: path.join(stateDir, "git", "git-new", "repo"),
    [Symbol.dispose]() {},
  };
}

function storedRecords(env: NodeJS.ProcessEnv) {
  return readConfigMachineState<unknown[]>(RETIRED_GIT_INSTALLS_STATE_KEY, { env });
}

async function remember(directory: ReturnType<typeof retiredCheckout>, pluginId = "demo-slow") {
  expect(
    await rememberRetiredGitPluginInstall({
      pluginId,
      env: directory.env,
      removal: {
        target: directory.repo,
        cleanup: { kind: "git", parentDir: directory.parentDir },
      },
    }),
  ).toBe(true);
}

it("keeps a retired git checkout while that generation is still in use", async () => {
  using directory = retiredCheckout();
  await remember(directory);
  const kept = await cleanupRetiredGitPluginInstalls({
    env: directory.env,
    pluginIds: ["demo-slow"],
    protectPaths: [path.join(directory.repo, "kept.txt")],
  });
  expect(kept.removed).toBe(0);
  expect(fs.readFileSync(path.join(directory.repo, "kept.txt"), "utf8")).toBe("old");
});

it("removes a retired git checkout after the replacement is the only user", async () => {
  using directory = retiredCheckout();
  fs.mkdirSync(directory.replacement, { recursive: true });
  await remember(directory);
  const removed = await cleanupRetiredGitPluginInstalls({
    env: directory.env,
    pluginIds: ["demo-slow"],
    protectPaths: [directory.replacement],
  });
  expect(removed.removed).toBe(1);
  expect(fs.existsSync(directory.repo)).toBe(false);
  expect(fs.existsSync(directory.parentDir)).toBe(false);
  expect(storedRecords(directory.env)).toBeUndefined();
});

it("leaves a checkout in place when the marker inode no longer matches", async () => {
  using directory = retiredCheckout();
  await remember(directory);
  updateConfigMachineState<Array<{ ino: string }>>(
    RETIRED_GIT_INSTALLS_STATE_KEY,
    (current) => {
      const [marker] = current ?? [];
      if (!marker) {
        throw new Error("missing retirement record");
      }
      return [{ ...marker, ino: "0" }];
    },
    { env: directory.env },
  );
  const removed = await cleanupRetiredGitPluginInstalls({
    env: directory.env,
    pluginIds: ["demo-slow"],
    protectPaths: [],
  });
  expect(removed.removed).toBe(0);
  expect(fs.readFileSync(path.join(directory.repo, "kept.txt"), "utf8")).toBe("old");
});

it("does not delete a marker that points outside the managed git root", async () => {
  using directory = retiredCheckout();
  const outside = tempDirs.make("openclaw-not-a-plugin-");
  fs.writeFileSync(path.join(outside, "kept.txt"), "stay");
  writeConfigMachineState(
    RETIRED_GIT_INSTALLS_STATE_KEY,
    [
      {
        version: 1,
        pluginId: "demo-slow",
        target: outside,
        parentDir: path.dirname(outside),
        dev: "1",
        ino: "1",
      },
    ],
    { env: directory.env },
  );
  const removed = await cleanupRetiredGitPluginInstalls({
    env: directory.env,
    protectPaths: [],
  });
  expect(removed.removed).toBe(0);
  expect(fs.readFileSync(path.join(outside, "kept.txt"), "utf8")).toBe("stay");
});

it("leaves an unmarked checkout in place", async () => {
  using directory = retiredCheckout();
  expect(await hasRetiredGitPluginInstallCandidates(directory.env)).toBe(false);
  const removed = await cleanupRetiredGitPluginInstalls({
    env: directory.env,
    protectPaths: [],
  });
  expect(removed.removed).toBe(0);
  expect(fs.readFileSync(path.join(directory.repo, "kept.txt"), "utf8")).toBe("old");
});

it("removes a package-owner checkout when reload names that owner", async () => {
  using directory = retiredCheckout();
  await remember(directory, "demo-package");
  expect(await hasRetiredGitPluginInstallCandidates(directory.env)).toBe(true);
  const removed = await cleanupRetiredGitPluginInstalls({
    env: directory.env,
    pluginIds: ["demo-plugin-npm"],
    installOwners: ["demo-package"],
    protectPaths: [directory.replacement],
  });
  expect(removed.removed).toBe(1);
  expect(fs.existsSync(directory.repo)).toBe(false);
});

it("keeps a checkout named by the current configuration", async () => {
  using directory = retiredCheckout();
  await remember(directory);
  const executable = path.join(directory.repo, "kept.txt");
  const removed = await cleanupRetiredGitPluginInstalls({
    env: directory.env,
    pluginIds: ["demo-slow"],
    protectPaths: collectConfiguredPluginReferencePaths([
      { plugins: { entries: { demo: { config: { command: executable } } } } },
    ]),
  });
  expect(removed.removed).toBe(0);
  expect(fs.readFileSync(executable, "utf8")).toBe("old");
});

it("stops before deleting when administrator authority is revoked", async () => {
  using directory = retiredCheckout();
  await remember(directory);
  await expect(
    cleanupRetiredGitPluginInstalls({
      env: directory.env,
      protectPaths: [],
      beforePersistentApply: () => {
        throw new Error("administrator revoked");
      },
    }),
  ).rejects.toThrow("administrator revoked");
  expect(fs.readFileSync(path.join(directory.repo, "kept.txt"), "utf8")).toBe("old");
  expect(storedRecords(directory.env)?.length).toBe(1);
});

it("keeps the retirement record when the state database cannot be read", async () => {
  using directory = retiredCheckout();
  await remember(directory);
  const databasePath = resolveOpenClawStateSqlitePath(directory.env);
  await closeOpenClawStateDatabaseAsync();
  fs.chmodSync(databasePath, 0);
  try {
    const removed = await cleanupRetiredGitPluginInstalls({
      env: directory.env,
      protectPaths: [],
    });
    expect(removed.removed).toBe(0);
    expect(removed.warnings.join("\n")).toContain("unable to open database file");
    expect(fs.readFileSync(path.join(directory.repo, "kept.txt"), "utf8")).toBe("old");
  } finally {
    fs.chmodSync(databasePath, 0o600);
    await closeOpenClawStateDatabaseAsync();
  }
  expect(storedRecords(directory.env)?.length).toBe(1);
});
