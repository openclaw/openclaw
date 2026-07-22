export type SessionObserverEvent = {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  data: Record<string, unknown>;
  lifecycleGeneration?: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
};

export type SessionObserverAskErrorReason =
  | "busy"
  | "disabled"
  | "not-subscribed"
  | "rate-limited"
  | "utility-model-unavailable"
  | "model-unavailable";

export class SessionObserverAskError extends Error {
  constructor(
    readonly reason: SessionObserverAskErrorReason,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "SessionObserverAskError";
  }
}

export type SessionObserverService = {
  handleEvent: (event: SessionObserverEvent) => void;
  ask: (params: {
    sessionKey: string;
    question: string;
    connId: string;
  }) => Promise<{ answer: string; digestRevision?: number }>;
  dispose: () => void;
};
