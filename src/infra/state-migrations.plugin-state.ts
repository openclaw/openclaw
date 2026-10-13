import fs from "node:fs";
import path from "node:path";
import type { ChannelLegacyStateMigrationPlan } from "../channels/plugins/types.core.js";
import {
  createPluginStateKeyedStore,
  registerMigratedPluginStateEntry,
} from "../plugin-state/plugin-state-store.js";
import { migrationFileExists } from "./state-migrations.fs.js";
import { archiveLegacyImportSource } from "./state-migrations.storage.js";
import type { MigrationMessages } from "./state-migrations.types.js";

function resolvePluginStateImportTargetKey(scopeKey: string, key: string): string {
  return scopeKey ? `${scopeKey}:${key}` : key;
}

function compareImportEntriesNewestFirst(
  a: { ttlMs?: number; timestamp?: number },
  b: { ttlMs?: number; timestamp?: number },
): number {
  if (a.timestamp !== undefined && b.timestamp !== undefined) {
    return b.timestamp - a.timestamp;
  }
  // Remaining TTL is monotone with recency for fixed-TTL caches.
  if (a.ttlMs !== undefined && b.ttlMs !== undefined) {
    return b.ttlMs - a.ttlMs;
  }
  return 0;
}

async function withPluginStateImportEnv(stateDir: string | undefined, run: () => Promise<void>) {
  if (!stateDir) {
    return await run();
  }
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previous;
    }
  }
}

export async function runLegacyMigrationPlans(
  plans: ChannelLegacyStateMigrationPlan[],
): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  let hasRefusal = false;
  // The declared source may feed several imports. Retire it after its last consumer,
  // while keeping unrelated sources in order and unique-source cleanup immediate.
  const lastConsumers = new Map(plans.map((plan, index) => [plan.sourcePath, index]));
  const cleanups = new Map<string, Array<() => Promise<void>>>();
  const incompleteSources = new Set<string>();
  for (const [index, plan] of plans.entries()) {
    const recordIncomplete = (message: string) => {
      hasRefusal = true;
      incompleteSources.add(plan.sourcePath);
      warnings.push(message);
    };
    let operation = `migrating ${plan.label} (${plan.sourcePath})`;
    try {
      if (incompleteSources.has(plan.sourcePath)) {
        recordIncomplete(
          `Deferred ${plan.label}: another migration of ${plan.sourcePath} did not complete.`,
        );
        continue;
      }
      if (plan.kind === "plugin-state-import") {
        const stateDir = plan.stateDir;
        await withPluginStateImportEnv(stateDir, async () => {
          const store = createPluginStateKeyedStore<unknown>(plan.pluginId, {
            namespace: plan.namespace,
            maxEntries: plan.maxEntries,
            ...(plan.defaultTtlMs != null ? { defaultTtlMs: plan.defaultTtlMs } : {}),
          });
          operation = `reading ${plan.label} plugin state before migration`;
          const storeEntries = await store.entries();
          const existingEntriesByKey = new Map(storeEntries.map((entry) => [entry.key, entry]));
          const expectedKeys = new Set(existingEntriesByKey.keys());
          const namespaceRemainingCapacity = Math.max(0, plan.maxEntries - storeEntries.length);
          operation = `reading ${plan.label} legacy source`;
          const entries = await plan.readEntries();
          operation = `migrating ${plan.label} (${plan.sourcePath})`;
          type CandidateEntry = (typeof entries)[number] & { targetKey: string };
          const replacementEntries: CandidateEntry[] = [];
          let newEntries: CandidateEntry[] = [];
          for (const entry of entries) {
            const targetKey = resolvePluginStateImportTargetKey(plan.scopeKey, entry.key);
            const existing = existingEntriesByKey.get(targetKey);
            if (existing) {
              const shouldReplace =
                existing.value !== undefined &&
                (await plan.shouldReplaceExistingEntry?.({
                  key: entry.key,
                  existingValue: existing.value,
                  incomingValue: entry.value,
                }));
              if (shouldReplace) {
                replacementEntries.push({ ...entry, targetKey });
              }
              continue;
            }
            newEntries.push({ ...entry, targetKey });
          }
          const missingEntryCount = newEntries.length;
          // Capacity limits must never turn the import into a permanent no-op: import the
          // newest entries that fit and defer the rest to a later startup (the legacy source
          // stays in place until every entry is covered).
          if (missingEntryCount > namespaceRemainingCapacity) {
            newEntries = newEntries
              .toSorted(compareImportEntriesNewestFirst)
              .slice(0, namespaceRemainingCapacity);
            const constraint = `plugin state namespace ${plan.namespace} has room for ${namespaceRemainingCapacity}`;
            recordIncomplete(
              newEntries.length > 0
                ? `Partially migrating ${plan.label} because ${constraint} of ${missingEntryCount} missing entries; importing the newest ${newEntries.length} and deferring the rest in the legacy source`
                : `Deferring ${plan.label} migration because ${constraint} of ${missingEntryCount} missing entries; left legacy source in place to retry when capacity frees`,
            );
          }
          // Eviction removes the smallest created_at first, so imported rows must
          // keep their legacy creation time; writing them through the normal
          // register path would stamp them "now" and let later live writes evict
          // fresher pre-existing rows before the migrated ones.
          const registerPreservingCreatedAt = async (params: {
            key: string;
            value: unknown;
            ttlMs?: number;
            createdAtMs?: number;
          }) => {
            if (
              params.createdAtMs === undefined ||
              !Number.isFinite(params.createdAtMs) ||
              params.createdAtMs < 0
            ) {
              await store.register(
                params.key,
                params.value,
                params.ttlMs != null ? { ttlMs: params.ttlMs } : undefined,
              );
              return;
            }
            registerMigratedPluginStateEntry({
              pluginId: plan.pluginId,
              namespace: plan.namespace,
              maxEntries: plan.maxEntries,
              ...(plan.defaultTtlMs != null ? { defaultTtlMs: plan.defaultTtlMs } : {}),
              key: params.key,
              value: params.value,
              ...(params.ttlMs != null ? { ttlMs: params.ttlMs } : {}),
              createdAtMs: params.createdAtMs,
            });
          };
          const restoreExistingEntry = async (key: string) => {
            const existing = existingEntriesByKey.get(key);
            await registerPreservingCreatedAt({
              key,
              value: existing?.value,
              createdAtMs: existing?.createdAt,
            });
          };
          let imported = 0;
          const changedKeys = new Set<string>();
          for (const entry of [...replacementEntries, ...newEntries]) {
            try {
              await registerPreservingCreatedAt({
                key: entry.targetKey,
                value: entry.value,
                ...(entry.ttlMs != null ? { ttlMs: entry.ttlMs } : {}),
                ...(entry.timestamp !== undefined ? { createdAtMs: entry.timestamp } : {}),
              });
              const liveKeys = new Set((await store.entries()).map(({ key }) => key));
              const missingKey = [...expectedKeys, entry.targetKey].find(
                (key) => !liveKeys.has(key),
              );
              if (missingKey) {
                // A concurrent write pushed the store over a cap and evicted a row. Roll back
                // only the entry whose write triggered the eviction, restore the evicted live
                // row when we still hold its value, and keep everything imported so far —
                // deferred entries stay in the legacy source for the next startup.
                if (existingEntriesByKey.has(entry.targetKey)) {
                  await restoreExistingEntry(entry.targetKey);
                } else {
                  await store.delete(entry.targetKey);
                }
                if (changedKeys.has(missingKey)) {
                  changedKeys.delete(missingKey);
                  expectedKeys.delete(missingKey);
                  imported = Math.max(0, imported - 1);
                } else if (existingEntriesByKey.has(missingKey)) {
                  try {
                    await restoreExistingEntry(missingKey);
                  } catch (restoreErr) {
                    recordIncomplete(
                      `Failed restoring ${plan.label} entry ${missingKey} after cap eviction: ${String(restoreErr)}`,
                    );
                  }
                }
                recordIncomplete(
                  `Paused migrating ${plan.label} because plugin state cap evicted ${missingKey}; imported ${imported} of ${missingEntryCount} missing entries and deferred the rest in the legacy source`,
                );
                break;
              }
              expectedKeys.add(entry.targetKey);
              changedKeys.add(entry.targetKey);
              imported++;
            } catch (err) {
              recordIncomplete(`Failed migrating ${plan.label} entry ${entry.key}: ${String(err)}`);
            }
          }
          if (imported > 0) {
            changes.push(
              `Migrated ${imported} ${plan.label} ${imported === 1 ? "entry" : "entries"} → plugin state`,
            );
          }
          // Entry failures fence cleanup for the whole source through recordIncomplete.
          const allEntriesCovered =
            (entries.length === 0 && plan.cleanupWhenEmpty === true) ||
            (entries.length > 0 &&
              entries.every(({ key }) =>
                expectedKeys.has(resolvePluginStateImportTargetKey(plan.scopeKey, key)),
              ));
          if (!allEntriesCovered || (!plan.cleanupSource && !plan.removeSource)) {
            return;
          }
          const pending = cleanups.get(plan.sourcePath) ?? [];
          pending.push(async () => {
            const cleanupWarnings: string[] = [];
            try {
              // Deferred callbacks may open stores implicitly; re-enter the import's owner scope.
              await withPluginStateImportEnv(stateDir, async () => {
                if (plan.cleanupSource === "rename" && migrationFileExists(plan.sourcePath)) {
                  archiveLegacyImportSource({
                    sourcePath: plan.sourcePath,
                    label: plan.label,
                    changes,
                    warnings: cleanupWarnings,
                  });
                }
                if (plan.cleanupSource === "remove" && migrationFileExists(plan.sourcePath)) {
                  try {
                    fs.unlinkSync(plan.sourcePath);
                    changes.push(`Removed ${plan.label} legacy source (${plan.sourcePath})`);
                  } catch (err) {
                    cleanupWarnings.push(
                      `Failed removing ${plan.label} legacy source: ${String(err)}`,
                    );
                  }
                }
                if (plan.removeSource) {
                  await plan.removeSource();
                  changes.push(`Removed ${plan.label} legacy source (${plan.sourcePath})`);
                }
              });
            } catch (err) {
              cleanupWarnings.push(`Failed removing ${plan.label} legacy source: ${String(err)}`);
            }
            // Shared-source cleanup is advisory only when every consumer permits it.
            const recoverable = plans.every(
              (consumer) =>
                consumer.sourcePath !== plan.sourcePath ||
                (consumer.kind === "plugin-state-import" &&
                  consumer.cleanupWarningDisposition === "recoverable"),
            );
            if (recoverable && cleanupWarnings.length > 0) {
              incompleteSources.add(plan.sourcePath);
              warnings.push(
                ...cleanupWarnings.map(
                  (warning) => `Run openclaw doctor --fix to retry legacy cleanup. ${warning}`,
                ),
              );
            } else {
              cleanupWarnings.forEach(recordIncomplete);
            }
          });
          cleanups.set(plan.sourcePath, pending);
        });
        continue;
      }
      if (migrationFileExists(plan.targetPath)) {
        continue;
      }
      fs.mkdirSync(path.dirname(plan.targetPath), { recursive: true });
      if (plan.kind === "move") {
        fs.renameSync(plan.sourcePath, plan.targetPath);
        changes.push(`Moved ${plan.label} → ${plan.targetPath}`);
      } else {
        fs.copyFileSync(plan.sourcePath, plan.targetPath);
        changes.push(`Copied ${plan.label} → ${plan.targetPath}`);
      }
    } catch (err) {
      recordIncomplete(`Failed ${operation}: ${String(err)}`);
    } finally {
      if (lastConsumers.get(plan.sourcePath) === index) {
        const pending = cleanups.get(plan.sourcePath) ?? [];
        cleanups.delete(plan.sourcePath);
        for (const cleanup of pending) {
          if (incompleteSources.has(plan.sourcePath)) {
            break;
          }
          await cleanup();
        }
      }
    }
  }
  return {
    changes,
    warnings,
    ...(warnings.length > 0 && !hasRefusal ? { warningDisposition: "recoverable" as const } : {}),
  };
}
