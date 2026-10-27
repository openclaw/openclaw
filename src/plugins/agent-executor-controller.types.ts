/** A native agent session's connection to a self-hosted executor. */
export type AgentExecutorBinding = {
  sessionKey: string;
  agentId: string;
  nativeSessionId: string;
  environmentId: string;
  remoteUrl: string;
  workspaceDirectory: string;
};

/** Authority for this operation; recheck after awaits and before side effects. */
export type AgentExecutorContext = {
  signal: AbortSignal;
  assertCurrent: () => void;
};

/** One plugin owns connection management for its configured executor workspace. */
export type AgentExecutorController = {
  /** Absolute path on the executor, which may differ from the Gateway workspace. */
  workspaceDirectory: string;
  /** Idempotently establish or reconnect this exact native environment. */
  ensure: (binding: AgentExecutorBinding, context: AgentExecutorContext) => Promise<void>;
  /** Idempotently retire this connection after native session work has settled. */
  retire: (binding: AgentExecutorBinding, context: AgentExecutorContext) => Promise<void>;
};
