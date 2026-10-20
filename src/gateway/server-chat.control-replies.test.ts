import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentRunTerminalReplySnapshot } from "../agents/agent-run-terminal-reply.types.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { registerChatRun } from "./server-chat.agent-events.test-helpers.js";
import { createWorkerChatProjection } from "./worker-environments/live-chat.test-support.js";

afterEach(() => {
  vi.useRealTimers();
  resetAgentEventsForTest({ preserveListeners: true });
});

function controlReplyProjection() {
  const runId = "control-reply-run";
  const sessionKey = "agent:main:control-reply";
  const projection = createWorkerChatProjection(sessionKey);
  registerChatRun(projection.state, runId, sessionKey, runId);
  registerAgentRunContext(runId, { sessionKey });
  return {
    ...projection,
    async emit(data: { text: string; itemId: string }) {
      emitAgentEvent({ runId, stream: "assistant", data });
      await projection.drain();
    },
    async finish(terminalReply: AgentRunTerminalReplySnapshot) {
      emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end", terminalReply } });
      await projection.drain();
    },
    async dispose() {
      try {
        await projection.dispose();
      } finally {
        clearAgentRunContext(runId);
      }
    },
  };
}

it.each([
  "NO_REPLY",
  "NO_REPLY.",
  "NO_REPLY\nNO_REPLY",
  '"NO_REPLY"',
  '{"reply":"NO_REPLY"}',
  "  NO_REPLY  \n",
])("keeps a producer-visible literal %j in stream and final events", async (text) => {
  const projection = controlReplyProjection();
  try {
    await projection.emit({ itemId: "visible", text });
    await projection.finish({ disposition: "visible", text });
    expect(projection.events.at(-1)).toMatchObject({
      state: "final",
      message: { content: [{ type: "text", text }] },
    });
    expect(projection.events[0]).toMatchObject({
      state: "delta",
      message: { content: [{ type: "text", text }] },
    });
  } finally {
    await projection.dispose();
  }
});

it("uses the full prepared buffer instead of the bounded terminal snapshot", async () => {
  const projection = controlReplyProjection();
  const text = `${"long answer ".repeat(500)}final bytes`;
  try {
    await projection.emit({ itemId: "visible", text });
    await projection.finish({ disposition: "visible", text: text.slice(0, 4_096) });
    expect(projection.events.at(-1)).toMatchObject({
      state: "final",
      message: { content: [{ type: "text", text }] },
    });
  } finally {
    await projection.dispose();
  }
});

it("publishes a silent terminal event without inventing final text", async () => {
  const projection = controlReplyProjection();
  try {
    await projection.finish({ disposition: "silent" });
    expect(projection.events).toEqual([expect.objectContaining({ state: "final" })]);
    expect(
      Reflect.get(expectDefined(projection.events[0], "terminal chat event"), "message"),
    ).toBeUndefined();
  } finally {
    await projection.dispose();
  }
});

it("retracts a visible prefix when the producer sends an empty replacement", async () => {
  vi.useFakeTimers();
  const projection = controlReplyProjection();
  try {
    await projection.emit({ itemId: "replacement", text: "Preparing a reply" });
    await projection.emit({ itemId: "replacement", text: "" });
    vi.advanceTimersByTime(200);
    expect(projection.events.at(-1)).toMatchObject({
      state: "delta",
      replace: true,
      deltaText: "",
      message: { content: [{ type: "text", text: "" }] },
    });
  } finally {
    await projection.dispose();
  }
});
