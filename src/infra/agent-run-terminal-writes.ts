import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import type { AgentRunDelegatedAuthority } from "./agent-run-authority.types.js";
import {
  captureAgentRunDelegatedSourceAssertion,
  getAgentRunContext,
  validateAgentRunDelegatedAuthority,
} from "./agent-run-registry.js";
import type { AgentRunContext } from "./agent-run-registry.types.js";

type OperationalRunInstance = AgentRunDelegatedAuthority["operationalRunInstance"];
type TerminalWriteContext = { run: <T>(write: () => T) => T };
type TerminalWrites = {
  instance: OperationalRunInstance;
  authority?: AgentRunDelegatedAuthority;
  context?: TerminalWriteContext;
  pending: Set<Promise<void>>;
};

const terminalWrites = new WeakMap<AgentRunContext, TerminalWrites>();
// Registry cleanup revokes writers, but cannot discard work already accepted by them.
const operationalTerminalWrites = new WeakMap<OperationalRunInstance, TerminalWrites>();

function prepareTerminalWrites(owner: AgentRunContext, instance: OperationalRunInstance) {
  let current = terminalWrites.get(owner);
  const retained = operationalTerminalWrites.get(instance);
  if (
    (retained && current !== retained) ||
    (owner.delegatedAuthority && owner.delegatedAuthority.operationalRunInstance !== instance)
  ) {
    throw new Error("Terminal write settlement owner changed");
  }
  if (!current || current.instance !== instance) {
    current = { instance, pending: new Set() };
    terminalWrites.set(owner, current);
  }
  operationalTerminalWrites.set(instance, current);
  return current;
}

/** Register settlement before a projected turn can fail prior to runtime admission. */
export function bindAgentRunTerminalWriteSettlement(instance: OperationalRunInstance): void {
  const owner = getAgentRunContext(instance.runId);
  if (owner) {
    prepareTerminalWrites(owner, instance);
  }
}

function trackTerminalWrite(current: TerminalWrites, persistence: Promise<void>): void {
  current.pending.add(persistence);
  const settled = () => current.pending.delete(persistence);
  void persistence.then(settled, settled);
}

/** Capture accepted-work settlement independently of permission to perform a write. */
export function captureAgentRunTerminalPersistence(runId: string) {
  const writeContext = captureAgentRunTerminalWriteContext(runId);
  const owner = getAgentRunContext(runId);
  const current = owner ? terminalWrites.get(owner) : undefined;
  return {
    writeContext,
    track:
      writeContext?.track ??
      (current
        ? (persistence: Promise<void>) => trackTerminalWrite(current, persistence)
        : undefined),
  };
}

/** Bind a prepared runtime's write context to its exact live operational owner. */
export function bindAgentRunTerminalWriteContext(
  authority: AgentRunDelegatedAuthority,
  context: TerminalWriteContext,
): void {
  const owner = getAgentRunContext(authority.operationalRunInstance.runId);
  if (owner?.delegatedAuthority !== authority || !validateAgentRunDelegatedAuthority(authority)) {
    throw new Error("Terminal write owner is no longer active");
  }
  const current = prepareTerminalWrites(owner, authority.operationalRunInstance);
  current.authority = authority;
  current.context = context;
}

/** A new fallback candidate cannot borrow the preceding runtime's account context. */
export function clearAgentRunTerminalWriteContext(instance: OperationalRunInstance): void {
  const owner = getAgentRunContext(instance.runId);
  const current = owner ? terminalWrites.get(owner) : undefined;
  if (current?.instance === instance) {
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
  if (!owner || !authority) {
    return undefined;
  }
  const refuse = (): never => {
    throw new Error("Terminal write owner changed before commit");
  };
  const source = captureAgentRunDelegatedSourceAssertion(authority, refuse);
  if (!source) {
    return undefined;
  }
  // Embedded runtimes have no account-specific CLI context, but their accepted
  // terminal writes must settle before the same operational admission closes.
  const current = prepareTerminalWrites(owner, authority.operationalRunInstance);
  current.authority ??= authority;
  if (current.authority !== authority) {
    return undefined;
  }
  const captured = current;
  const context = captured.context;
  const assertBinding = () => {
    if (
      getAgentRunContext(runId) !== owner ||
      terminalWrites.get(owner) !== captured ||
      captured.context !== context ||
      owner.delegatedAuthority !== captured.authority ||
      captured.authority !== authority
    ) {
      refuse();
    }
    source.assertBinding();
  };
  const assertCurrent = composeSessionSourceAssertion([source.assertCurrent], (assertSource) => {
    assertBinding();
    assertSource();
  });
  return {
    assertCurrent,
    run: (write) => {
      assertBinding();
      return context ? context.run(write) : write();
    },
    track: (persistence) => trackTerminalWrite(captured, persistence),
  };
}

/** Normal completion joins accepted terminal writes; explicit authority close stays immediate. */
export async function drainAgentRunTerminalWrites(instance: OperationalRunInstance): Promise<void> {
  const current = operationalTerminalWrites.get(instance);
  if (current) {
    while (current.pending.size > 0) {
      await Promise.allSettled(current.pending);
    }
  }
}
