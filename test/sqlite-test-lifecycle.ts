import path from "node:path";
import { normalizeModuleId, type EvaluatedModuleNode } from "vite/module-runner";
import { vi } from "vitest";

const source = (name: string) => normalizeModuleId(path.resolve(import.meta.dirname, "..", name));
const agentSource = source("src/state/openclaw-agent-db-lifecycle.ts");
const agentKey = Symbol.for("openclaw.agentDatabaseLifecycle");
const brokerKey = Symbol.for("openclaw.sqliteWorkerBroker");
const coordinatorPoolKey = Symbol.for("openclaw.sqliteCoordinatorPool");
const resetKey = Symbol.for("openclaw.globalSingletonLifecycleResets");
const retainedCustodyKey = Symbol.for("openclaw.sqliteTestRetainedCustody");

// These owners retain module closures and each other's lifecycle callbacks.
// Keep their native custody intact through drainage, then retire the whole generation.
export const sqliteTestSingletonPublications: ReadonlyMap<string, symbol> = new Map([
  [
    source("src/state/openclaw-state-worker-store.ts"),
    Symbol.for("openclaw.sharedStateWorkerOwner"),
  ],
  [source("src/infra/sqlite-worker-store.ts"), brokerKey],
  [source("src/infra/sqlite-coordinator.ts"), coordinatorPoolKey],
  [source("src/state/openclaw-state-db-cache.ts"), Symbol.for("openclaw.stateDatabaseLifecycle")],
  [
    source("src/state/openclaw-state-db-snapshot-owner.ts"),
    Symbol.for("openclaw.stateSnapshotOwners"),
  ],
  [source("src/state/openclaw-state-read-worker.ts"), Symbol.for("openclaw.stateReadWorkers")],
  [source("src/gateway/session-group-catalog.ts"), Symbol.for("openclaw.sessionGroupCatalog")],
  [agentSource, agentKey],
]);

type AgentLifecycleModule = Pick<
  typeof import("../src/state/openclaw-agent-db-lifecycle.js"),
  "agentDatabaseLifecycle" | "closeOpenClawAgentDatabasesAsync"
>;
type AgentOwner = AgentLifecycleModule["agentDatabaseLifecycle"];
const agentClosers = new WeakMap<AgentOwner, () => Promise<void>>();

type SingletonReset = {
  lifecycle: "close-and-restart" | "close-only" | "plugin-registry";
  reset: () => void | Promise<void>;
};

function retainedCustody() {
  const store = globalThis as typeof globalThis & {
    [retainedCustodyKey]?: { sqlite: boolean; failedResets: WeakSet<SingletonReset> };
  };
  return (store[retainedCustodyKey] ??= { sqlite: false, failedResets: new WeakSet() });
}

export function hasRetainedSqliteTestCustody(): boolean {
  return retainedCustody().sqlite;
}

export function retainSqliteTestCustody(): void {
  // A non-main-thread broker refusal leaves its lease for the process-death stale-lease sweep.
  // Until retirement facts exist, later files must not retry the closer or retire its broker.
  retainedCustody().sqlite = true;
}

/** Settle independent owners before shared storage; a failure retains its dependent family. */
export async function drainSqliteTestSingletons(
  onError: (phase: string, error: unknown) => void,
): Promise<void> {
  const resets = (globalThis as Record<PropertyKey, unknown>)[resetKey] as
    | Map<symbol, SingletonReset>
    | undefined;
  const { failedResets } = retainedCustody();
  const entries = [...(resets ?? [])].filter(
    ([, reset]) => reset.lifecycle !== "plugin-registry" && !failedResets.has(reset),
  );
  const sqliteKeys = new Set(sqliteTestSingletonPublications.values());
  await Promise.all(
    entries
      .filter(([key]) => !sqliteKeys.has(key))
      .map(async ([key, reset]) => {
        try {
          await reset.reset();
        } catch (error) {
          failedResets.add(reset);
          onError(`singleton ${key.description}`, error);
        }
      }),
  );
  // Native and broker retirement can return a coordinator to the idle pool.
  const closeOrder = (key: symbol) => (key === coordinatorPoolKey ? 2 : Number(key === brokerKey));
  const sqlite = entries
    .filter(([key]) => sqliteKeys.has(key))
    .toSorted(([left], [right]) => closeOrder(left) - closeOrder(right));
  for (const [key, reset] of sqlite) {
    if (hasRetainedSqliteTestCustody()) {
      break;
    }
    try {
      await reset.reset();
    } catch (error) {
      retainSqliteTestCustody();
      onError(`singleton ${key.description}`, error);
    }
  }
}

/** Preserve the verified owner's closer before a test hook can reset its module exports. */
export function rememberSqliteTestAgentOwner(
  modules: Iterable<EvaluatedModuleNode>,
  executions: ReadonlyMap<string, { external?: boolean }>,
): void {
  const owner = (globalThis as Record<PropertyKey, unknown>)[agentKey] as AgentOwner | undefined;
  if (!owner || agentClosers.has(owner)) {
    return;
  }
  for (const node of modules) {
    if (node.file !== agentSource) {
      continue;
    }
    const execution = executions.get(node.id.startsWith("mock:") ? node.id.slice(5) : node.id);
    const exports = node.exports as Partial<AgentLifecycleModule> | undefined;
    if (
      execution &&
      !execution.external &&
      exports &&
      exports.agentDatabaseLifecycle === owner &&
      typeof exports.closeOpenClawAgentDatabasesAsync === "function" &&
      !vi.isMockFunction(exports.closeOpenClawAgentDatabasesAsync)
    ) {
      agentClosers.set(owner, exports.closeOpenClawAgentDatabasesAsync);
      return;
    }
  }
}

/** Agent lease cleanup still needs its original shared-state owner and broker. */
export async function drainSqliteTestAgentOwner(
  modules: Iterable<EvaluatedModuleNode>,
  executions: ReadonlyMap<string, { external?: boolean }>,
  testFiles: string,
): Promise<void> {
  rememberSqliteTestAgentOwner(modules, executions);
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const owner = globalStore[agentKey] as AgentLifecycleModule["agentDatabaseLifecycle"] | undefined;
  const resources = globalStore[Symbol.for("openclaw.agentDatabaseAsyncResources")] as
    | { active: Set<unknown>; closing: Map<unknown, unknown>; selections: Set<unknown> }
    | undefined;
  const custody = () => ({
    databases: owner?.databases.size ?? 0,
    leases: owner?.leases.size ?? 0,
    pending: owner?.pending.size ?? 0,
    activePending: owner?.activePending.size ?? 0,
    retainedCloses: owner?.retainedCloses.size ?? 0,
    resources: resources?.active.size ?? 0,
    closing: resources?.closing.size ?? 0,
    selections: resources?.selections.size ?? 0,
  });
  const hasCustody = () => Object.values(custody()).some((count) => count > 0);
  if (!hasCustody()) {
    return;
  }
  console.warn(
    `[sqlite-test-lifecycle] ${testFiles}: draining agent database custody ${JSON.stringify(custody())}`,
  );
  const close = owner && agentClosers.get(owner);
  if (close) {
    await close();
  }
  // A module reset can erase the real closer. Never load a replacement under the
  // file's mocks or abandon handles just to make the next file start cleanly.
  if (hasCustody()) {
    throw new Error(
      `SQLite test teardown cannot retire agent owners with unsettled database custody from ${testFiles}: ${JSON.stringify(custody())}`,
    );
  }
}

/** Called only for an evaluated source generation, after successful owner drainage. */
export function retireSqliteTestSingleton(key: symbol, testFiles: string): void {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const resets = globalStore[resetKey] as Map<symbol, unknown> | undefined;
  if (key === agentKey) {
    const owner = globalStore[agentKey] as AgentOwner | undefined;
    if (owner) {
      agentClosers.delete(owner);
    }
  }
  if (Object.hasOwn(globalStore, key)) {
    console.warn(`[sqlite-test-lifecycle] ${testFiles}: retiring ${key.description}`);
  }
  Reflect.deleteProperty(globalStore, key);
  resets?.delete(key);
}
