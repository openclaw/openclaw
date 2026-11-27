import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readUpdateStateDatabaseInventory } from "./update-candidate-state.js";
import { createUpdateDatabaseBackup } from "./update-database-backup.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

async function fixture() {
  const root = await fs.realpath(dirs.make("inventory-result-"));
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir);
  const paths = Array.from({ length: 300 }, (_, i) =>
    path.join(
      stateDir,
      ...Array<string>(24).fill("a".repeat(80)),
      `agent-${i}`,
      "openclaw-agent.sqlite",
    ),
  );
  return {
    stateDir,
    paths,
    env: {
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      TMPDIR: root,
      XDG_CACHE_HOME: root,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
    config: {
      agents: {
        entries: Object.fromEntries(
          paths.map((agentDir, i) => [`agent-${i}`, { agentDir: path.dirname(agentDir) }]),
        ),
      },
    },
  };
}

it("returns discovered database inventory larger than stdout's cap", async () => {
  const { paths, ...input } = await fixture();
  const inventory = await readUpdateStateDatabaseInventory(input);
  const actual = new Set([...inventory.values()].flatMap((entry) => entry.spellings));
  expect(paths.filter((file) => !actual.has(file))).toEqual([]);
  expect(Buffer.byteLength(JSON.stringify([...inventory]))).toBeGreaterThan(1024 * 1024);
});

it("returns the complete large backup receipt while missing databases stay missing", async () => {
  const { paths, ...input } = await fixture();
  const result = await createUpdateDatabaseBackup({
    ...input,
    backupRoot: path.join(input.env.HOME, "backup"),
  });
  expect(result.databases).toEqual([]);
  const missing = new Set(result.missingPaths);
  const sources = new Set(result.sourcePaths);
  expect(paths.filter((file) => !missing.has(file) || !sources.has(file))).toEqual([]);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(1024 * 1024);
});
