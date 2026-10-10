import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
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
    async finish() {
      emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
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

it("keeps repeated control-only items hidden while the next marker is incomplete", async () => {
  const projection = controlReplyProjection();
  try {
    for (let item = 0; item < 6; item++) {
      const fragments =
        item === 0 ? ["REP", "REPLY_", "REPLY_SKIP"] : ["R", "RE", "REP", "REPLY_", "REPLY_SKIP"];
      for (const text of fragments) {
        await projection.emit({ itemId: `control-${item}`, text });
      }
    }
    await projection.finish();
    expect(projection.events).toEqual([expect.objectContaining({ state: "final" })]);
    expect(
      Reflect.get(expectDefined(projection.events[0], "terminal chat event"), "message"),
    ).toBeUndefined();
  } finally {
    await projection.dispose();
  }
});

it("retracts a visible prefix when a replacement becomes a control-only reply", async () => {
  vi.useFakeTimers();
  const projection = controlReplyProjection();
  try {
    await projection.emit({ itemId: "replacement", text: "Preparing a reply" });
    await projection.emit({ itemId: "replacement", text: "REPLY_SKIP" });
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
