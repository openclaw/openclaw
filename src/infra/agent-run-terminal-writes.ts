import type { AgentRunDelegatedAuthority } from "./agent-run-authority.types.js";
import {
  getAgentRunContext,
  getAgentRunContextOwnerStatus,
  validateAgentRunDelegatedAuthority,
} from "./agent-run-registry.js";
import type { AgentRunContext } from "./agent-run-registry.types.js";

type OperationalRunInstance = AgentRunDelegatedAuthority["operationalRunInstance"];
type TerminalWriteContext = { run: <T>(write: () => T) => T };
type TerminalWrites = {
  authority: AgentRunDelegatedAuthority;
  context?: TerminalWriteContext;
  contextRevision: number;
  pending: Set<Promise<void>>;
};

const terminalWrites = new WeakMap<AgentRunContext, TerminalWrites>();

/** Bind terminal writes, optionally within a prepared runtime's account context. */
export function bindAgentRunTerminalWrites(
  authority: AgentRunDelegatedAuthority,
  context?: TerminalWriteContext,
): void {
  const runId = authority.operationalRunInstance.runId;
  const owner = getAgentRunContext(runId);
  if (
    !validateAgentRunDelegatedAuthority(authority) ||
    !owner ||
    getAgentRunContext(runId) !== owner ||
    owner.delegatedAuthority !== authority ||
    getAgentRunContextOwnerStatus(runId, authority.claimId, authority.lifecycleGeneration) !==
      "active"
  ) {
    throw new Error("Terminal write owner is no longer active");
  }
  const current = terminalWrites.get(owner);
  if (current?.authority === authority) {
    if (context !== undefined && current.context !== context) {
      current.context = context;
      current.contextRevision++;
    }
  } else {
    terminalWrites.set(owner, { authority, context, contextRevision: 0, pending: new Set() });
  }
}

/** A new fallback candidate cannot borrow the preceding runtime's account context. */
export function clearAgentRunTerminalWriteContext(instance: OperationalRunInstance): void {
  const owner = getAgentRunContext(instance.runId);
  const current = owner ? terminalWrites.get(owner) : undefined;
  if (current?.authority.operationalRunInstance === instance) {
    // Even undefined -> context -> undefined must revoke the original capture.
    current.context = undefined;
    current.contextRevision++;
  }
}

export type CapturedAgentRunTerminalWriteContext = TerminalWriteContext & {
  assertCurrent: () => void;
  track: (persistence: Promise<void>) => void;
};

/** Capture before async session resolution; a replaced candidate revokes this exact capture. */
export function captureAgentRunTerminalWriteContext(
  runId: string,
): CapturedAgentRunTerminalWriteContext | undefined {
  const owner = getAgentRunContext(runId);
  const current = owner ? terminalWrites.get(owner) : undefined;
  const context = current?.context;
  const contextRevision = current?.contextRevision;
  if (!owner || !current) {
    return undefined;
  }
  const assertCurrent = () => {
    if (
      !validateAgentRunDelegatedAuthority(current.authority) ||
      getAgentRunContext(runId) !== owner ||
      terminalWrites.get(owner) !== current ||
      current.context !== context ||
      current.contextRevision !== contextRevision ||
      owner.delegatedAuthority !== current.authority ||
      getAgentRunContextOwnerStatus(
        runId,
        current.authority.claimId,
        current.authority.lifecycleGeneration,
      ) !== "active"
    ) {
      throw new Error("Terminal write owner changed before commit");
    }
  };
  try {
    assertCurrent();
  } catch {
    return undefined;
  }
  return {
    assertCurrent,
    run: (write) => {
      assertCurrent();
      return context ? context.run(write) : write();
    },
    track: (persistence) => {
      current.pending.add(persistence);
      const settled = () => current.pending.delete(persistence);
      void persistence.then(settled, settled);
    },
  };
}

/** Normal completion joins accepted terminal writes; explicit authority close stays immediate. */
export async function drainAgentRunTerminalWrites(instance: OperationalRunInstance): Promise<void> {
  const owner = getAgentRunContext(instance.runId);
  const current = owner ? terminalWrites.get(owner) : undefined;
  if (current?.authority.operationalRunInstance === instance) {
    while (current.pending.size > 0) {
      await Promise.allSettled(current.pending);
    }
  }
}
