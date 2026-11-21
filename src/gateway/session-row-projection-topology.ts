import { createSubagentSessionListReadView } from "../agents/subagents/registry/subagent-registry-state.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/state-dir.js";
import { prepareAgentDatabaseDeletionSnapshotRead } from "../state/agent-deletion-journal.read.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as profiles from "../state/user-profile-list.js";
import type { createSessionRowEntryReadAccess } from "./session-row-membership-read.js";
import { SessionRowFactsPending } from "./session-row-prepared-read.js";
import * as records from "./session-row-projection-record.js";
import { prepareSessionRowScopes } from "./session-row-scope.js";

export async function prepareSessionRowTopologySources() {
  const env = cloneEnvWithPlatformSemantics(process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const profileCatalogPath = resolveOpenClawStateSqlitePath(env);
  const discoveryRead = prepareAgentDatabaseDeletionSnapshotRead({ env }, "runtime-discovery");
  const subagents = createSubagentSessionListReadView({ env });
  if (!subagents.snapshotIdentity()) {
    await subagents.prepare();
  }
  return { env, profileCatalogPath, discoveryRead, subagents };
}

/** Admission prepares physical stores; the projection alone publishes their rows and scope. */
export function createSessionRowTopology(owner: {
  env: NodeJS.ProcessEnv;
  profileCatalogPath: string;
  discovery: ReturnType<typeof prepareAgentDatabaseDeletionSnapshotRead>;
  run: <T>(operation: () => T) => T;
  state: () => {
    disposed: boolean;
    dirty: boolean;
    epoch: number;
    cfg: records.Inputs["cfg"];
    stores: Map<string, records.SessionRowStore>;
  };
  config: () => records.Inputs["cfg"];
  rows: Map<string, records.Row>;
  byStore: Map<string, Set<string>>;
  byAgent: ReadonlyMap<string, ReadonlySet<string>>;
  createStoreRead: ReturnType<typeof createSessionRowEntryReadAccess>["createStoreRead"];
  remove: (id: string) => void;
  put: (row: records.Row) => void;
  acquire: (row: records.Row, entry: records.Row["storedEntry"]) => void;
  setConfig: (cfg: records.Inputs["cfg"]) => void;
  setStores: (stores: Map<string, records.SessionRowStore>) => void;
  publish: (scope: ReturnType<typeof prepareSessionRowScopes>) => void;
  prepareExactRows: (queries: readonly records.Lookup[]) => Promise<void> | undefined;
}) {
  let pending: Promise<void> | undefined;
  return () => {
    const state = owner.state();
    if (
      state.disposed ||
      (!state.dirty && profiles.isUserProfileCatalogReady(owner.profileCatalogPath))
    ) {
      return Promise.resolve();
    }
    return (pending ??= owner
      .run(async () => {
        if (!profiles.isUserProfileCatalogReady(owner.profileCatalogPath)) {
          (await profiles.prepareUserProfileCatalog({ env: owner.env })).release();
        }
        const current = owner.state();
        if (current.disposed || !current.dirty) {
          return;
        }
        const revision = current.epoch;
        const nextConfig = owner.config();
        const prepared = await owner.discovery.readWithCurrentAdmission();
        prepared.assertCurrent();
        const isCurrent = () => !owner.state().disposed && owner.state().epoch === revision;
        if (!isCurrent()) {
          return;
        }
        const discovery = { env: owner.env, snapshot: prepared.snapshot };
        while (isCurrent()) {
          try {
            const storeRead = owner.createStoreRead({
              stores: owner.state().stores,
              rows: owner.rows,
              byStore: owner.byStore,
              env: owner.env,
            });
            await storeRead.loadCombinedStore(nextConfig, discovery, (load, scopes) => {
              prepared.assertCurrent();
              if (!isCurrent()) {
                return;
              }
              const loaded = load();
              owner.setConfig(nextConfig);
              const acquisitions = records.seedSessionRowEntries({
                targets: loaded.targetsBySessionKey,
                rows: owner.rows,
                replaced: storeRead.replaced,
                remove: owner.remove,
                put: owner.put,
              });
              owner.setStores(storeRead.sources);
              // Every stored identity precedes an earlier store selecting a later parent.
              for (const { row, entry } of acquisitions) {
                owner.acquire(row, entry);
              }
              storeRead.updateMembership();
              owner.publish(
                prepareSessionRowScopes(
                  nextConfig,
                  owner.byAgent.keys(),
                  new Map(Array.from(storeRead.sources, ([key, { filename }]) => [filename, key])),
                  scopes,
                ),
              );
            });
            break;
          } catch (error) {
            if (!isCurrent()) {
              break;
            }
            if (!(error instanceof SessionRowFactsPending)) {
              throw error;
            }
            await owner.prepareExactRows(error.queries);
          }
        }
      })
      .finally(() => {
        pending = undefined;
      }));
  };
}
