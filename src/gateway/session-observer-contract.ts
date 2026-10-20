import type { AgentEventPayload } from "../infra/agent-events.js";

export type SessionObserverEvent = AgentEventPayload;

export type SessionObserverCompanionSnapshot = {
  agentId: string;
  runId?: string;
  digest?: import("../../packages/gateway-protocol/src/schema/sessions.js").SessionObserverDigest;
  notes: Array<{ sequence: number; text: string }>;
};

export type SessionObserverService = {
  /** @deprecated Await handleEventAsync. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
  handleEvent: (event: SessionObserverEvent) => void;
  handleEventAsync: (event: SessionObserverEvent) => Promise<void>;
  setConnectionVisibility: (connId: string, visible: boolean) => void;
  removeConnection: (connId: string) => void;
  /** @deprecated Await getCompanionSnapshotAsync. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
  getCompanionSnapshot: (sessionKey: string, agentId?: string) => SessionObserverCompanionSnapshot;
  getCompanionSnapshotAsync: (
    sessionKey: string,
    agentId?: string,
  ) => Promise<SessionObserverCompanionSnapshot>;
  /** @deprecated Use disposeAsync to join accepted work before closing database workers. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
  dispose: () => void;
  disposeAsync: () => Promise<void>;
};
