import { afterEach, expect, it, vi } from "vitest";
import type { AgentRunTerminalReplySnapshot } from "../agents/agent-run-terminal-reply.types.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { registerChatRun } from "./server-chat.agent-events.test-helpers.js";
import { createWorkerChatProjection } from "./worker-environments/live-chat.test-support.js";

const runId = "control-reply-run";
const sessionKey = "agent:main:control-reply";
let projection: ReturnType<typeof createWorkerChatProjection>;
afterEach(async () => {
  try {
    await projection.dispose();
  } finally {
    clearAgentRunContext(runId);
    vi.useRealTimers();
    resetAgentEventsForTest({ preserveListeners: true });
  }
});

function setup() {
  projection = createWorkerChatProjection(sessionKey);
  registerChatRun(projection.state, runId, sessionKey, runId);
  registerAgentRunContext(runId, { sessionKey });
}

async function emit(text: string, itemId = "visible") {
  emitAgentEvent({ runId, stream: "assistant", data: { text, itemId } });
  await projection.drain();
}
async function finish(terminalReply: AgentRunTerminalReplySnapshot) {
  emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end", terminalReply } });
  await projection.drain();
}
const message = (text: string) => ({ content: [{ type: "text", text }] });

it.each([
  "NO_REPLY",
  "NO_REPLY.",
  "NO_REPLY\nNO_REPLY",
  '"NO_REPLY"',
  '{"reply":"NO_REPLY"}',
  "  NO_REPLY  \n",
])("keeps a producer-visible literal %j in stream and final events", async (text) => {
  setup();
  await emit(text);
  await finish({ disposition: "visible", text });
  expect(projection.events.at(-1)).toMatchObject({ state: "final", message: message(text) });
  expect(projection.events[0]).toMatchObject({ state: "delta", message: message(text) });
});

it("uses the full prepared buffer instead of the bounded terminal snapshot", async () => {
  setup();
  const text = `${"long answer ".repeat(500)}final bytes`;
  await emit(text);
  await finish({ disposition: "visible", text: text.slice(0, 4_096) });
  expect(projection.events.at(-1)).toMatchObject({ state: "final", message: message(text) });
});

it("publishes a silent terminal event without inventing final text", async () => {
  setup();
  await finish({ disposition: "silent" });
  expect(projection.events).toEqual([expect.objectContaining({ state: "final" })]);
  expect(Reflect.get(projection.events[0]!, "message")).toBeUndefined();
});

it("retracts a visible prefix when the producer sends an empty replacement", async () => {
  vi.useFakeTimers();
  setup();
  await emit("Preparing a reply", "replacement");
  await emit("", "replacement");
  vi.advanceTimersByTime(200);
  expect(projection.events.at(-1)).toMatchObject({
    state: "delta",
    replace: true,
    deltaText: "",
    message: message(""),
  });
});
