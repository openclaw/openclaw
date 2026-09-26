import type { AgentRunDelegatedAuthority } from "./agent-run-authority.types.js";
import { getAgentRunContext, validateAgentRunDelegatedAuthority } from "./agent-run-registry.js";
import type { AgentRunContext } from "./agent-run-registry.types.js";

type OperationalRunInstance = AgentRunDelegatedAuthority["operationalRunInstance"];
type TerminalWriteContext = { run: <T>(write: () => T) => T };
type TerminalWrites = {
  authority: AgentRunDelegatedAuthority;
  context?: TerminalWriteContext;
  pending: Set<Promise<void>>;
};

const terminalWrites = new WeakMap<AgentRunContext, TerminalWrites>();

/** Bind a prepared runtime's write context to its exact live operational owner. */
export function bindAgentRunTerminalWriteContext(
  authority: AgentRunDelegatedAuthority,
  context: TerminalWriteContext,
): void {
  const owner = getAgentRunContext(authority.operationalRunInstance.runId);
  if (owner?.delegatedAuthority !== authority || !validateAgentRunDelegatedAuthority(authority)) {
    throw new Error("Terminal write owner is no longer active");
  }
  const current = terminalWrites.get(owner);
  if (current?.authority === authority) {
    current.context = context;
  } else {
    terminalWrites.set(owner, { authority, context, pending: new Set() });
  }
}

/** A new fallback candidate cannot borrow the preceding runtime's account context. */
export function clearAgentRunTerminalWriteContext(instance: OperationalRunInstance): void {
  const owner = getAgentRunContext(instance.runId);
  const current = owner ? terminalWrites.get(owner) : undefined;
  if (current?.authority.operationalRunInstance === instance) {
    current.context = undefined;
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
  const authority = owner?.delegatedAuthority;
  if (!owner || !authority || !validateAgentRunDelegatedAuthority(authority)) {
    return undefined;
  }
  // Embedded runtimes have no account-specific CLI context, but their accepted
  // terminal writes must settle before the same operational admission closes.
  let current = terminalWrites.get(owner);
  if (!current) {
    current = { authority, pending: new Set() };
    terminalWrites.set(owner, current);
  }
  if (current.authority !== authority) {
    return undefined;
  }
  const captured = current;
  const context = captured.context;
  const assertCurrent = () => {
    if (
      getAgentRunContext(runId) !== owner ||
      terminalWrites.get(owner) !== captured ||
      captured.context !== context ||
      owner.delegatedAuthority !== captured.authority ||
      !validateAgentRunDelegatedAuthority(captured.authority)
    ) {
      throw new Error("Terminal write owner changed before commit");
    }
  };
  return {
    assertCurrent,
    run: (write) => {
      assertCurrent();
      return context ? context.run(write) : write();
    },
    track: (persistence) => {
      captured.pending.add(persistence);
      const settled = () => captured.pending.delete(persistence);
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
