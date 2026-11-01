import { AsyncLocalStorage } from "node:async_hooks";
import { toUSVString } from "node:util";
import { serialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import type { EngineConnection } from "../infra/sql-connection.js";
import { sqlPublicationAnchor } from "../infra/sql-connection.js";
import type { SqliteCommitReceipt, SqliteCommittedFact } from "../infra/sqlite-commit-receipt.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "../infra/sqlite-worker-contract.js";
import {
  deferSqliteWorkerCommitReceipt,
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionFactory,
} from "../infra/sqlite-worker-operation-admission.js";
import { observeSqliteWorkerAdmissionFinish } from "../infra/sqlite-worker-operation-settlement.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  createKeyedStateDomainPublication,
  type StateDomainChange,
} from "../state/state-domain-publication.js";

type PluginStateRow = Selectable<DB["plugin_state_entries"]>;
type EntryKey = Pick<PluginStateRow, "plugin_id" | "namespace" | "entry_key">;
type Receipt = SqliteCommitReceipt<PluginStateRow>;
type PluginStateChange = StateDomainChange<PluginStateRow>;
type SubmittedFact = { kind: "submitted"; value: Omit<PluginStateRow, "value_json"> };

function resolveSubmittedReceipt(
  receipt: unknown,
  submitted: ReadonlyMap<string, string> | undefined,
): unknown {
  if (!isRecord(receipt) || !(receipt.facts instanceof Map)) {
    return receipt;
  }
  const facts: ReadonlyMap<unknown, unknown> = receipt.facts;
  let resolved: Map<unknown, unknown> | undefined;
  for (const [key, fact] of facts) {
    if (!isRecord(fact) || fact.kind !== "submitted") {
      continue;
    }
    const valueJson = typeof key === "string" ? submitted?.get(key) : undefined;
    if (valueJson === undefined || !isRecord(fact.value)) {
      // Finished admissions release their inputs; late references cannot publish partial rows.
      return undefined;
    }
    resolved ??= new Map(facts);
    resolved.set(key, { kind: "postimage", value: { ...fact.value, value_json: valueJson } });
  }
  return resolved ? { ...receipt, facts: resolved } : receipt;
}

export type PluginStatePublicationScope = {
  pluginId: string;
  namespace: string;
  /** Omitted when the write can affect any live entry in the namespace. */
  key?: string;
};
/** Possible effects derived from the serialized command, never supplied by plugin callers. */
export type PluginStatePublicationEffect =
  | { readonly kind: "unchanged" }
  | { readonly kind: "postimage"; readonly valueJson: string };
type PendingPublication = {
  scope?: PluginStatePublicationScope;
  effect?: PluginStatePublicationEffect;
};

/** Descriptive read dependencies; these snapshots never grant mutation authority. */
export type PluginStateReadDependency = {
  /** A missing database uses a wildcard so its first committed creation invalidates absence. */
  identity?: string | symbol;
  pluginId: string;
  namespace: string;
  keys: readonly string[];
};

type PluginStateReadCapture = {
  dependencies: PluginStateReadDependency[];
  assertions: Array<() => void>;
  accepting: boolean;
  keyCount: number;
};

const state = resolveGlobalSingleton(Symbol.for("openclaw.pluginStatePublication"), () => ({
  reads: new AsyncLocalStorage<PluginStateReadCapture>(),
  pending: new Map<string | symbol, Set<PendingPublication>>(),
  unavailable: new Set<string | symbol>(),
}));

const publication = createKeyedStateDomainPublication<PluginStateRow>({
  domain: "plugin-state",
  isFact: (key, fact) =>
    fact.kind === "absent" ||
    (fact.kind === "postimage" &&
      isRow(fact.value) &&
      pluginStatePublicationKey(fact.value) === key),
  invalidReceiptMessage: "Plugin state commit receipt is invalid",
  installFailureMessage: "Plugin state fact installation failed",
  mutationDuringInstallMessage: "Plugin state cannot mutate during fact installation",
  closedMessage: "Plugin state publication is closed",
  changedOwnerMessage: "Plugin state receipt changed owner",
});

/** Match SQLite text binding without changing public comparison-token scopes. */
export function pluginStatePublicationKey(row: EntryKey): string {
  return JSON.stringify([row.plugin_id, row.namespace, toUSVString(row.entry_key)]);
}

publication.subscribeFacts((change) => {
  if (change.kind === "unknown") {
    state.unavailable.add(change.identity);
  }
});

/** Owns committed-fact staging and observation; raw/foreign authority remains separate. */
export const pluginStatePublication = {
  stagePostimage: stagePluginStatePostimage,
  stageDeletions: stagePluginStateDeletions,
  /** Install/invalidate prepared facts only. */
  subscribeFacts: publication.subscribeFacts,
};

/** Record the actual keyed store read without opening or inspecting another database. */
export function recordPluginStateReadDependency(
  dependency: PluginStateReadDependency & { assertCurrent?: () => void },
): void {
  const capture = state.reads.getStore();
  if (!capture) {
    return;
  }
  if (!capture.accepting) {
    throw new Error("Plugin state read capture has ended");
  }
  capture.keyCount += dependency.keys.length;
  if (capture.keyCount > 10_000) {
    throw new Error("Plugin state ownership reads exceeded 10,000 dependency keys");
  }
  const { assertCurrent, ...source } = dependency;
  capture.dependencies.push({ ...source, keys: [...source.keys] });
  if (assertCurrent) {
    capture.assertions.push(assertCurrent);
  }
}

/** Pending work is not new committed truth; indeterminate outcomes retire the whole source. */
export function pluginStateReadDependenciesAffected(
  dependencies: readonly PluginStateReadDependency[],
  change: PluginStateChange,
): boolean {
  if (change.kind === "pending" || change.kind === "settled") {
    return false;
  }
  const identity = change.kind === "committed" ? change.receipt.source.identity : change.identity;
  return dependencies.some((dependency) => {
    if (dependency.identity !== undefined && dependency.identity !== identity) {
      return false;
    }
    if (change.kind === "committed") {
      return dependency.keys.some((key) =>
        change.receipt.facts.has(
          pluginStatePublicationKey({
            plugin_id: dependency.pluginId,
            namespace: dependency.namespace,
            entry_key: key,
          }),
        ),
      );
    }
    return change.kind === "unknown";
  });
}

/** Keep the transient witness until its consumer installs the dependencies in its own cache. */
export async function capturePluginStateReadDependencies<T>(read: () => Promise<T>) {
  const capture: PluginStateReadCapture = {
    dependencies: [],
    assertions: [],
    accepting: true,
    keyCount: 0,
  };
  let active = true;
  let changed = false;
  const stop = pluginStatePublication.subscribeFacts((change) => {
    if (pluginStateReadDependenciesAffected(capture.dependencies, change)) {
      changed = true;
    }
  });
  const release = () => {
    active = false;
    capture.accepting = false;
    stop();
  };
  const assertCurrent = () => {
    if (!active || changed) {
      throw new Error("Plugin state changed while preparing session ownership");
    }
    for (const assertSourceCurrent of capture.assertions) {
      assertSourceCurrent();
    }
  };
  try {
    const value = await state.reads.run(capture, read);
    capture.accepting = false;
    return {
      value,
      dependencies: Object.freeze(capture.dependencies),
      assertCurrent,
      isCurrent() {
        try {
          assertCurrent();
          return true;
        } catch {
          return false;
        }
      },
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}

function stagePluginStatePostimage(db: EngineConnection, row: PluginStateRow): void {
  publication.stageFacts(
    db,
    new Map([[pluginStatePublicationKey(row), { kind: "postimage", value: { ...row } }]]),
  );
}

/** DELETE RETURNING captures exact tombstones, including eviction and whole-namespace clear. */
function stagePluginStateDeletions(db: EngineConnection, rows: readonly EntryKey[]): void {
  publication.stageDeletions(db, rows.map(pluginStatePublicationKey));
}

export type PluginStateCommitReceipt = Receipt;

/** Lend exact staged facts to a compound owner's existing settlement receipt. */
export function capturePluginStateReceipt<T>(db: EngineConnection, write: () => T) {
  return publication.capture(db, write);
}

/** Capture the whole native transaction before COMMIT, including keys changed by retention. */
export function withPluginStateWorkerReceipt<T>(
  db: EngineConnection,
  submitted: ReadonlyMap<string, string> | undefined,
  write: () => T,
  additionalFacts?: (result: T) => Record<string, unknown>,
): T {
  const { result, receipt: captured } = capturePluginStateReceipt(db, write);
  // Empty receipts distinguish a confirmed no-op from missing commit evidence.
  const metadata = additionalFacts?.(result);
  const facts = submitted
    ? new Map<string, SqliteCommittedFact<PluginStateRow> | SubmittedFact>(
        [...captured.facts].map(([key, fact]) => {
          if (fact.kind === "postimage") {
            const { value_json, ...value } = fact.value;
            if (submitted.get(key) === value_json) {
              return [key, { kind: "submitted", value }];
            }
          }
          return [key, fact];
        }),
      )
    : captured.facts;
  const receipt = { ...metadata, ...captured, facts };
  // Publication cannot make a previously valid large clear/import fail to commit.
  // Unbounded retained namespaces may exceed the transport even with keys alone.
  deferSqliteWorkerCommitReceipt(
    sqlPublicationAnchor(db),
    serialize(receipt).byteLength <= SQLITE_WORKER_MAX_MESSAGE_BYTES
      ? receipt
      : { ...metadata, kind: "unknown", identity: receipt.source.identity },
    captured.facts.size === 0 ? "settlement" : "commit",
  );
  return result;
}

function isRow(value: unknown): value is PluginStateRow {
  return (
    isRecord(value) &&
    typeof value.plugin_id === "string" &&
    typeof value.namespace === "string" &&
    typeof value.entry_key === "string" &&
    typeof value.value_json === "string" &&
    (typeof value.created_at === "number" || typeof value.created_at === "bigint") &&
    (value.expires_at === null ||
      typeof value.expires_at === "number" ||
      typeof value.expires_at === "bigint")
  );
}

/** Deny affected pending writes; an indeterminate outcome retires the whole source. */
export function assertPluginStatePublicationSettled(
  identity: string,
  scope?: PluginStatePublicationScope,
): void {
  if (state.unavailable.has(identity)) {
    throw new Error("Plugin state authority is unavailable");
  }
  if (hasPendingPluginStatePublication(identity, scope)) {
    throw new Error("Plugin state authority is unavailable");
  }
}

/** Descriptive views may reload after unknown settlement; authority remains unavailable. */
export function hasPendingPluginStatePublication(
  identity: string,
  scope?: PluginStatePublicationScope,
): boolean {
  for (const pending of state.pending.get(identity) ?? []) {
    const write = pending.scope;
    if (publicationScopesOverlap(scope, write)) {
      return true;
    }
  }
  return false;
}

function publicationScopesOverlap(
  scope: PluginStatePublicationScope | undefined,
  write: PluginStatePublicationScope | undefined,
): boolean {
  return (
    !scope ||
    !write ||
    (scope.pluginId === write.pluginId &&
      scope.namespace === write.namespace &&
      (scope.key === undefined ||
        write.key === undefined ||
        toUSVString(scope.key) === toUSVString(write.key)))
  );
}

/** A predicate may survive a pending change; the caller must also validate committed truth. */
export function assertPluginStatePublicationPreserves(
  identity: string,
  scope: PluginStatePublicationScope,
  assertValueCurrent: (value: unknown) => void,
): void {
  if (state.unavailable.has(identity)) {
    throw new Error("Plugin state authority is unavailable");
  }
  for (const pending of state.pending.get(identity) ?? []) {
    if (!publicationScopesOverlap(scope, pending.scope)) {
      continue;
    }
    if (!pending.effect) {
      throw new Error("Plugin state authority is unavailable");
    }
    if (pending.effect.kind === "postimage") {
      assertValueCurrent(JSON.parse(pending.effect.valueJson));
    }
  }
}

/** Start denial before queueing work; committed-only lease checks remain usable by its owner. */
export function beginPluginStatePublication(
  identity: () => string | symbol,
  assertCurrent?: () => void,
  scope?: PluginStatePublicationScope,
  effect?: PluginStatePublicationEffect,
) {
  const pendingIdentity = identity();
  const hold = { scope, effect };
  const holds = state.pending.get(pendingIdentity) ?? new Set<PendingPublication>();
  holds.add(hold);
  state.pending.set(pendingIdentity, holds);
  const release = () => {
    if (holds.delete(hold) && holds.size === 0) {
      state.pending.delete(pendingIdentity);
    }
  };
  let pending: ReturnType<typeof publication.begin>;
  try {
    pending = publication.begin({
      identity: pendingIdentity,
      assertCurrent() {
        assertCurrent?.();
        if (identity() !== pendingIdentity) {
          throw new Error("Plugin state receipt changed owner");
        }
      },
    });
  } catch (error) {
    release();
    throw error;
  }
  return {
    install: pending.committed,
    finish(outcome: "completed" | "unknown") {
      release();
      pending.finish(outcome === "completed", true);
    },
  };
}

/** A late worker reply cannot overwrite a newer native publication or reopen a closed owner. */
export function withPluginStatePublication(
  createAdmission: SqliteWorkerAdmissionFactory,
  context: OpenClawStateWorkerContext,
  values: ReadonlyMap<string, string> | undefined,
  onCommitted?: (facts: unknown) => void,
  scope?: PluginStatePublicationScope,
  effect?: PluginStatePublicationEffect,
): SqliteWorkerAdmissionFactory {
  let submitted = values;
  return (operation) => {
    const owner = createAdmission(operation);
    let pending: ReturnType<typeof beginPluginStatePublication>;
    try {
      pending = beginPluginStatePublication(
        () => context.admission.identity.key,
        context.assertPublicationCurrent ?? context.admission.assertCurrent,
        scope,
        effect,
      );
    } catch (error) {
      owner.admission.finish();
      throw error;
    }
    let installed = false;
    observeSqliteWorkerAdmissionFinish(owner.admission, () => {
      submitted = undefined;
      const settlement = owner.admission.settlement;
      // A completed rollback has no receipt; a committed write must publish before denial ends.
      pending.finish(
        settlement?.kind === "completed" && (!settlement.committed || installed)
          ? "completed"
          : "unknown",
      );
    });
    observeSqliteWorkerCommittedFacts(owner.admission, ({ facts }) => {
      const resolved = resolveSubmittedReceipt(facts, submitted);
      if (resolved === undefined) {
        pending.finish("unknown");
        return;
      }
      pending.install(resolved);
      installed = true;
      onCommitted?.(resolved);
    });
    return owner;
  };
}
