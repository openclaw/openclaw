import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelLegacyStateMigrationPlan } from "../channels/plugins/legacy-state-migration.types.js";
import {
  createPluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { runLegacyMigrationPlans } from "./state-migrations.plugin-state.js";

type ImportPlan = Extract<ChannelLegacyStateMigrationPlan, { kind: "plugin-state-import" }>;

describe("legacy migration plan failure isolation", () => {
  let state: OpenClawTestState;
  let importStateDir: string;
  const store = <T>(namespace: string, maxEntries = 4, directory = importStateDir) =>
    createPluginStateKeyedStore<T>("migration-fixture", {
      namespace,
      maxEntries,
      env: { ...state.env, OPENCLAW_STATE_DIR: directory },
    });
  function importPlan(
    params: Pick<ImportPlan, "label" | "namespace" | "sourcePath" | "readEntries"> &
      Partial<ImportPlan>,
  ): ImportPlan {
    return {
      kind: "plugin-state-import",
      pluginId: "migration-fixture",
      maxEntries: 4,
      scopeKey: "",
      targetPath: `plugin state:${params.namespace}`,
      stateDir: importStateDir,
      ...params,
    };
  }
  const artifactPlan = (kind: "move" | "copy", label: string, sourcePath: string) => ({
    kind,
    label,
    sourcePath,
    targetPath: `${sourcePath}.${kind === "move" ? "moved" : "copied"}`,
  });

  const runExisting = (plans: ChannelLegacyStateMigrationPlan[]) =>
    runLegacyMigrationPlans(plans.filter((plan) => fs.existsSync(plan.sourcePath)));
  async function expectRetired(sourcePath: string, original: string, run: () => Promise<unknown>) {
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.readFileSync(`${sourcePath}.migrated`, "utf8")).toBe(original);
    expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
    await expect(run()).resolves.toEqual({ changes: [], warnings: [] });
  }

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "migration-plan-isolation" });
    importStateDir = state.statePath("import-owner");
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests({ closeDatabase: false });
    await state.cleanup();
  });

  it.each([
    { failure: "predicate", cleanupFirst: false },
    { failure: "rejection", cleanupFirst: false },
    { failure: "reader", cleanupFirst: false },
    { failure: "capacity", cleanupFirst: false },
    { failure: "predicate", cleanupFirst: true },
    { failure: "empty", cleanupFirst: false },
  ] as const)(
    "defers shared-source cleanup ($failure, cleanupFirst=$cleanupFirst)",
    async ({ failure, cleanupFirst }) => {
      // iMessage derives a durable short-id counter and an expiring cache from one JSONL file.
      const original = "legacy reply cache\n";
      const sourcePath = await state.writeText("reply-cache.jsonl", original);
      const unrelatedPath = await state.writeText("unrelated.txt", "independent artifact\n");
      const earlierPath = await state.writeText("earlier.txt", "earlier artifact\n");
      const counter = store<{ counter: number }>("shared-counter", 1);
      const counterKey = "scope:counter";
      await counter.register(failure === "capacity" ? "occupied" : counterKey, { counter: 1 });
      let shouldFail = true;
      const counterObservedMove: boolean[] = [];
      const counterPlan = importPlan({
        label: "Reply counter",
        sourcePath,
        namespace: "shared-counter",
        scopeKey: "scope",
        maxEntries: 1,
        readEntries: () => {
          counterObservedMove.push(fs.existsSync(`${unrelatedPath}.copied`));
          if (failure === "reader" && shouldFail) {
            throw new Error("synthetic counter read failure");
          }
          return failure === "empty" ? [] : [{ key: "counter", value: { counter: 9000 } }];
        },
        shouldReplaceExistingEntry: () => {
          if (failure === "predicate" && shouldFail) {
            throw new Error("synthetic counter callback failure");
          }
          if (failure === "rejection" && shouldFail) {
            return Promise.reject(new Error("synthetic counter callback failure"));
          }
          return true;
        },
      });
      const cachePlan = importPlan({
        label: "Expired reply cache",
        sourcePath,
        namespace: "shared-cache",
        cleanupSource: "rename",
        cleanupWhenEmpty: true,
        readEntries: () => [],
      });
      const unrelatedPlan = artifactPlan("copy", "Unrelated artifact", unrelatedPath);
      const plans = [
        artifactPlan("move", "Earlier artifact", earlierPath),
        ...(cleanupFirst
          ? [cachePlan, unrelatedPlan, counterPlan]
          : [counterPlan, cachePlan, unrelatedPlan]),
      ];
      const run = () => runExisting(plans);

      const first = await run();

      expect(counterObservedMove).toEqual([cleanupFirst]);
      expect(fs.readFileSync(`${earlierPath}.moved`, "utf8")).toBe("earlier artifact\n");
      expect(fs.readFileSync(`${unrelatedPath}.copied`, "utf8")).toBe("independent artifact\n");
      expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
      expect(await counter.lookup(counterKey)).toEqual(
        failure === "capacity" ? undefined : { counter: 1 },
      );
      if (failure === "empty") {
        expect(first.warnings).toEqual([]);
        await expectRetired(sourcePath, original, run);
        return;
      }

      expect(fs.readFileSync(sourcePath, "utf8")).toBe(original);
      expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(false);
      expect(first.warnings).toContainEqual(expect.stringContaining("Reply counter"));

      shouldFail = false;
      if (failure === "capacity") {
        await counter.delete("occupied");
      }
      const repaired = await run();

      expect(repaired.warnings).toEqual([]);
      expect(await counter.lookup(counterKey)).toEqual({ counter: 9000 });
      expect(repaired.changes).toContainEqual(
        expect.stringContaining("Migrated 1 Reply counter entry"),
      );
      await expectRetired(sourcePath, original, run);
    },
  );

  it.each([false, true])(
    "scopes cleanup before later imports (throws: %s)",
    async (cleanupThrows) => {
      const storeOptions = { namespace: "old-rows", maxEntries: 4 };
      const ambient = store<string>("old-rows", 4, state.stateDir);
      const owner = store<string>("old-rows");
      await ambient.register("legacy", "ambient");
      await owner.register("legacy", "owner");
      const cleanupScopes: Array<string | undefined> = [];
      const laterObservedCleanup: boolean[] = [];
      const plans: ChannelLegacyStateMigrationPlan[] = [
        importPlan({
          label: "Scoped rows",
          sourcePath: "plugin state:old-rows",
          namespace: "first-import",
          readEntries: () => [{ key: "first", value: "imported" }],
          removeSource: async () => {
            cleanupScopes.push(process.env.OPENCLAW_STATE_DIR);
            if (cleanupThrows) {
              throw new Error("synthetic cleanup failure");
            }
            const scopedStore = createPluginStateKeyedStore("migration-fixture", storeOptions);
            await scopedStore.delete("legacy");
          },
        }),
        importPlan({
          label: "Later rows",
          sourcePath: "plugin state:unrelated-rows",
          namespace: "later-import",
          readEntries: async () => {
            const scopedStore = createPluginStateKeyedStore("migration-fixture", storeOptions);
            laterObservedCleanup.push((await scopedStore.lookup("legacy")) === undefined);
            return [{ key: "later", value: "completed" }];
          },
        }),
      ];

      const result = await runLegacyMigrationPlans(plans);

      expect(cleanupScopes).toEqual([importStateDir]);
      expect(laterObservedCleanup).toEqual([!cleanupThrows]);
      expect(await ambient.lookup("legacy")).toBe("ambient");
      expect(await owner.lookup("legacy")).toBe(cleanupThrows ? "owner" : undefined);
      expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
      expect(result.changes).toContainEqual(expect.stringContaining("Migrated 1 Later rows entry"));
      expect(result.warnings).toEqual(
        cleanupThrows ? [expect.stringContaining("synthetic cleanup failure")] : [],
      );
    },
  );
});
