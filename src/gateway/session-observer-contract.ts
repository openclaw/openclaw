import type { AgentEventPayload } from "../infra/agent-events.js";

export type SessionObserverEvent = AgentEventPayload;

export type SessionObserverCompanionSnapshot = {
  agentId: string;
  runId?: string;
  digest?: import("../../packages/gateway-protocol/src/schema/sessions.js").SessionObserverDigest;
  notes: Array<{ sequence: number; text: string }>;
};

export type SessionObserverService = {
  /** @deprecated Await handleEventAsync. Retained during stable deprecation. */
  handleEvent: (event: SessionObserverEvent) => void;
  handleEventAsync: (event: SessionObserverEvent) => Promise<void>;
  setConnectionVisibility: (connId: string, visible: boolean) => void;
  removeConnection: (connId: string) => void;
  /** @deprecated Await getCompanionSnapshotAsync. Retained during stable deprecation. */
  getCompanionSnapshot: (sessionKey: string, agentId?: string) => SessionObserverCompanionSnapshot;
  getCompanionSnapshotAsync: (
    sessionKey: string,
    agentId?: string,
  ) => Promise<SessionObserverCompanionSnapshot>;
  /** @deprecated Use disposeAsync to join accepted work before closing database workers. */
  dispose: () => void;
  disposeAsync: () => Promise<void>;
};
