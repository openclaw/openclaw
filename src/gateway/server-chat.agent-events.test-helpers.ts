import type { AgentEventPayload, AgentEventStream } from "../infra/agent-events.js";
import type { ChatRunRegistration, ChatRunState } from "./server-chat-state.js";

type AgentEventHandler = (event: AgentEventPayload) => void;

type AgentEventOverrideKey =
  | "agentId"
  | "lifecycleGeneration"
  | "seq"
  | "sessionId"
  | "sessionKey"
  | "ts";
type AgentEventOverrides = {
  [Key in AgentEventOverrideKey]?: AgentEventPayload[Key] | undefined;
};
type AgentEventCase = readonly [
  stream: AgentEventStream,
  data: Record<string, unknown>,
  overrides?: AgentEventOverrides,
];

export function emitAgentEvent(
  handler: AgentEventHandler,
  runId: string,
  stream: AgentEventStream,
  data: Record<string, unknown>,
  overrides: AgentEventOverrides = {},
) {
  handler({ runId, seq: 1, stream, ts: Date.now(), data, ...overrides });
}

export function emitAgentEvents(
  handler: AgentEventHandler,
  runId: string,
  events: readonly AgentEventCase[],
) {
  events.forEach(([stream, data, overrides], index) =>
    emitAgentEvent(handler, runId, stream, data, { seq: index + 1, ...overrides }),
  );
}

export function registerChatRun(
  state: ChatRunState,
  runId: string,
  sessionKey: string,
  clientRunId: string,
  overrides: Omit<ChatRunRegistration, "clientRunId" | "sessionKey"> = {},
) {
  state.registry.add(runId, { sessionKey, clientRunId, ...overrides });
}

export function registerNamedChatRun(
  state: ChatRunState,
  name: string,
  overrides: Omit<ChatRunRegistration, "clientRunId" | "sessionKey"> = {},
) {
  registerChatRun(state, `run-${name}`, `session-${name}`, `client-${name}`, overrides);
}
