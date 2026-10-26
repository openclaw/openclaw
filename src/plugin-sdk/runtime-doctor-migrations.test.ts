import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelLegacyStateMigrationPlan } from "../channels/plugins/legacy-state-migration.types.js";
import {
  createPluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import * as sdk from "./runtime-doctor-migrations.js";

const runLegacyMigrationPlans = vi.hoisted(() => vi.fn());
const executorModuleLoads = vi.hoisted(() => vi.fn());

vi.mock("../infra/state-migrations.plugin-state.js", () => {
  executorModuleLoads();
  return { runLegacyMigrationPlans };
});

describe("defineLegacyJsonStateMigration retention", () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  let context: sdk.PluginDoctorStateMigrationContext;
  const openStore = () =>
    context.openPluginStateKeyedStore({ namespace: "entries", maxEntries: 2 });
  const params = () => ({ config: {}, env, stateDir, oauthDir: stateDir, context });
  const sourcePath = () => path.join(stateDir, "legacy.json");
  const migration = (id: string) =>
    sdk.defineLegacyJsonStateMigration({
      id,
      label: "Fixture entries",
      resolvePath: sourcePath,
      parse: (value) => value as { key: string; value: string }[],
      namespace: "entries",
      maxEntries: 2,
      describeEntries: () => ({
        preview: ["legacy entries"],
        change: ({ imported }) => `Migrated ${imported} entries`,
      }),
      toRows: (entries) => entries,
    });

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-json-migration-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    context = {
      openPluginStateKeyedStore: (options) =>
        createPluginStateKeyedStore("migration-fixture", { ...options, env }),
    };
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("refuses malformed UTF-8 before importing or archiving legacy plugin state", async () => {
    const source = Buffer.from('[{"key":"entry","value":"\xff"}]', "latin1");
    await fs.writeFile(sourcePath(), source);
    const subject = migration("utf8-fixture");
    await expect(subject.detectLegacyState(params())).resolves.toEqual({
      preview: [expect.stringContaining("UTF-8")],
    });
    await expect(subject.migrateLegacyState(params())).resolves.toEqual({
      changes: [],
      warnings: [expect.stringContaining("UTF-8")],
      warningDisposition: "recoverable",
    });
    expect(await openStore().entries()).toEqual([]);
    expect(await fs.readFile(sourcePath())).toEqual(source);
    expect(await fs.readdir(stateDir)).not.toContain("legacy.json.migrated");
  });

  it.each(["imported", "pre-existing"])(
    "preserves the source and warns when a row is evicted (%s)",
    async (evicted) => {
      const rows = ["first", "second", ...(evicted === "imported" ? ["third"] : [])].map((key) => ({
        key,
        value: key,
      }));
      const source = JSON.stringify(rows);
      await fs.writeFile(sourcePath(), source);
      const store = openStore();
      if (evicted === "pre-existing") {
        await store.register("existing", "canonical");
      }
      const subject = migration("retention-fixture");
      const result = await subject.migrateLegacyState(params());
      expect(await store.entries()).toHaveLength(2);
      expect(result).toEqual({
        changes: [],
        warnings: [expect.stringContaining("failed to retain every required entry (1 missing)")],
      });
      await expect(fs.readFile(sourcePath(), "utf8")).resolves.toBe(source);
      await expect(fs.access(`${sourcePath()}.migrated`)).rejects.toThrow();
      await expect(subject.detectLegacyState(params())).resolves.not.toBeNull();
    },
  );
});

const migrationInput = {
  config: {},
  env: {},
  stateDir: "/state",
  oauthDir: "/oauth",
  context: { openPluginStateKeyedStore: vi.fn() } as never,
};

const plans: ChannelLegacyStateMigrationPlan[] = [
  {
    kind: "plugin-state-import",
    label: "Cache",
    sourcePath: "/state/cache.json",
    targetPath: "plugin state:cache",
    pluginId: "demo",
    namespace: "cache",
    maxEntries: 10,
    scopeKey: "",
    readEntries: () => [],
  },
  {
    kind: "move",
    label: "Credentials",
    sourcePath: "/oauth/creds.json",
    targetPath: "/oauth/demo/creds.json",
  },
];
it.each([
  { input: [], preview: null },
  {
    input: plans,
    preview: {
      preview: [
        "- Cache: /state/cache.json",
        "- Credentials: /oauth/creds.json → /oauth/demo/creds.json",
      ],
    },
  },
])("adapts migration plans without eagerly loading the executor", async ({ input, preview }) => {
  const migration = sdk.definePluginDoctorMigrationFromPlans({
    id: "demo-state",
    label: "Demo state",
    resolvePlans: () => input,
  });
  await expect(migration.detectLegacyState(migrationInput)).resolves.toEqual(preview);
  if (!input.length) {
    return;
  }
  expect(executorModuleLoads).not.toHaveBeenCalled();
  const result = { changes: ["migrated"], warnings: ["warning"] };
  runLegacyMigrationPlans.mockResolvedValueOnce(structuredClone(result));
  await expect(migration.migrateLegacyState(migrationInput)).resolves.toEqual(result);
  expect(executorModuleLoads).toHaveBeenCalledTimes(1);
  expect(runLegacyMigrationPlans.mock.calls[0]?.[0]).toEqual([
    { ...plans[0], stateDir: "/state" },
    plans[1],
  ]);
});
