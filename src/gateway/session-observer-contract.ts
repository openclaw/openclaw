import type { AgentEventPayload } from "../infra/agent-events.js";

export type SessionObserverEvent = AgentEventPayload;

export type SessionObserverCompanionSnapshot = {
  agentId: string;
  runId?: string;
  digest?: import("../../packages/gateway-protocol/src/schema/sessions.js").SessionObserverDigest;
  notes: Array<{ sequence: number; text: string }>;
};

export type SessionObserverService = {
  handleEvent: (event: SessionObserverEvent) => void;
  setConnectionVisibility: (connId: string, visible: boolean) => void;
  removeConnection: (connId: string) => void;
  getCompanionSnapshot: (sessionKey: string, agentId?: string) => SessionObserverCompanionSnapshot;
  dispose: () => void;
};
