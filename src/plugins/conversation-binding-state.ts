import { createDedupeCache, type DedupeCache } from "../infra/dedupe.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { normalizeChannel } from "./conversation-binding-session-key.js";
import type { PluginBindingApprovalEntry } from "./conversation-binding-state.types.js";

export type { PluginBindingApprovalEntry } from "./conversation-binding-state.types.js";
const log = createSubsystemLogger("plugins/binding");
type PluginBindingApprovalsState = { approvals: PluginBindingApprovalEntry[] };
type PluginBindingGlobalState = {
  fallbackNoticeBindingIds: DedupeCache;
  approvalsCache: PluginBindingApprovalsState | null;
  approvalTail?: Promise<void>;
  operations: Set<Promise<void>>;
  generation: number;
  resetting?: Promise<void>;
};

export const pluginBindingGlobalState = resolveGlobalSingleton<PluginBindingGlobalState>(
  Symbol.for("openclaw.plugins.binding.global-state"),
  () => ({
    fallbackNoticeBindingIds: createDedupeCache({ ttlMs: 0, maxSize: 4_096 }),
    approvalsCache: null,
    operations: new Set(),
    generation: 0,
  }),
  (state) => {
    if (state.resetting) {
      return state.resetting;
    }
    state.generation++;
    const clear = () => {
      state.fallbackNoticeBindingIds.clear();
      state.approvalsCache = null;
    };
    if (!state.operations.size && !state.approvalTail) {
      clear();
      return undefined;
    }
    // Keep admitted decisions and their cache publication owned until settlement.
    state.resetting = Promise.allSettled([
      ...state.operations,
      ...(state.approvalTail ? [state.approvalTail] : []),
    ]).then(() => {
      clear();
      state.resetting = undefined;
    });
    return state.resetting;
  },
);

export async function withPluginBindingApprovalOperation<T>(
  run: (assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  const state = pluginBindingGlobalState;
  const generation = state.generation;
  const assertCurrent = () => {
    if (state.resetting || state.generation !== generation) {
      throw new Error("Plugin conversation binding operation closed. Retry the bind request.");
    }
  };
  assertCurrent();
  let release!: () => void;
  const retained = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.operations.add(retained);
  try {
    return await run(assertCurrent);
  } finally {
    state.operations.delete(retained);
    release();
  }
}

function buildApprovalScopeKey(params: {
  pluginRoot: string;
  channel: string;
  accountId: string;
}): string {
  return [
    params.pluginRoot,
    normalizeChannel(params.channel),
    params.accountId.trim() || "default",
  ].join("::");
}

function serializeApprovalOperation<T>(run: () => Promise<T>): Promise<T> {
  const state = pluginBindingGlobalState;
  const operation = (state.approvalTail ?? Promise.resolve()).then(run);
  const tail = operation.then(
    () => {},
    () => {},
  );
  state.approvalTail = tail;
  void tail.then(() => {
    if (state.approvalTail === tail) {
      state.approvalTail = undefined;
    }
  });
  return operation;
}

async function getApprovals(
  context: OpenClawStateWorkerContext,
): Promise<PluginBindingApprovalsState> {
  if (pluginBindingGlobalState.approvalsCache) {
    return pluginBindingGlobalState.approvalsCache;
  }
  let approvals: PluginBindingApprovalEntry[];
  try {
    const { runOpenClawStateWorkerOperation } =
      await import("../state/openclaw-state-worker-store.js");
    approvals = await runOpenClawStateWorkerOperation(context, (scope) =>
      scope.execute({ type: "plugins.conversationBindingApprovals.read", input: undefined }),
    );
  } catch (error) {
    log.warn(`plugin binding approvals load failed: ${String(error)}`);
    approvals = [];
  }
  return (pluginBindingGlobalState.approvalsCache = { approvals });
}

export function hasPersistentApproval(params: {
  pluginRoot: string;
  channel: string;
  accountId: string;
}): Promise<boolean> {
  const key = buildApprovalScopeKey(params);
  const context = captureOpenClawStateWorkerContext();
  return serializeApprovalOperation(async () =>
    (await getApprovals(context)).approvals.some((entry) => buildApprovalScopeKey(entry) === key),
  );
}

export function addPersistentApproval(entry: PluginBindingApprovalEntry): Promise<void> {
  const prepared = { ...entry };
  const key = buildApprovalScopeKey(prepared);
  const context = captureOpenClawStateWorkerContext();
  return serializeApprovalOperation(async () => {
    const { runOpenClawStateWorkerOperation } =
      await import("../state/openclaw-state-worker-store.js");
    // A failed write must never publish permission that did not reach disk.
    await runOpenClawStateWorkerOperation(context, (scope) =>
      scope.execute({ type: "plugins.conversationBindingApprovals.upsert", input: prepared }),
    );
    const approvals = (await getApprovals(context)).approvals.filter(
      (existing) => buildApprovalScopeKey(existing) !== key,
    );
    approvals.push(prepared);
    pluginBindingGlobalState.approvalsCache = { approvals };
  });
}
