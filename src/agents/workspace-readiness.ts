import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type AgentWorkspaceReadiness = Readonly<{
  sessionKey: string;
  waitUntilReady: () => Promise<void>;
  assertCurrent: () => void;
  isReady?: () => boolean;
  getFailure?: () => Error | undefined;
}>;

const workspaceReadiness = resolveGlobalSingleton(
  Symbol.for("openclaw.agentWorkspaceReadiness"),
  () => new AsyncLocalStorage<AgentWorkspaceReadiness | undefined>(),
);

export function runWithAgentWorkspaceReadiness<T>(
  readiness: AgentWorkspaceReadiness | undefined,
  run: () => Promise<T>,
): Promise<T> {
  return workspaceReadiness.run(readiness, run);
}

/** Capture the session owner before handing tools to another async context. */
export function captureAgentWorkspaceReadiness(
  sessionKey?: string,
): AgentWorkspaceReadiness | undefined {
  const captured = workspaceReadiness.getStore();
  return sessionKey && captured?.sessionKey === sessionKey ? captured : undefined;
}
