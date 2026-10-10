import { Value } from "typebox/value";
import { afterEach, expect, it, vi } from "vitest";
import { AgentEventSchema } from "../../packages/gateway-protocol/src/schema/agent.js";
import type { AgentEventRuntimePayload } from "../infra/agent-events.js";
import { createAgentEventTestHarness } from "./server-chat.agent-events.test-harness.js";

afterEach(() => vi.useRealTimers());

it.each(["", "First answer."])(
  "publishes the retained preamble projection: %j",
  async (retained) => {
    vi.useFakeTimers();
    const h = createAgentEventTestHarness();
    h.register("run", "main", "run");
    try {
      const text = retained ? `${retained}\n\nChecking again.` : "Checking again.";
      await h.emit("run", "assistant", { itemId: "message", text, delta: text }, { seq: 1 });
      const event: AgentEventRuntimePayload = {
        runId: "run",
        seq: 2,
        ts: Date.now(),
        stream: "item",
        data: {
          kind: "preamble",
          itemId: "commentary",
          phase: "end",
          progressText: "Checking again.",
        },
      };
      Object.defineProperty(event, "assistantProjection", {
        value: { itemId: "message", text: retained, replace: true },
      });
      await h.handler(event);
      h.chatRunState.flushPendingText("run");
      const payload = h.agent().at(-1)?.[1];
      expect(payload).toMatchObject({
        stream: "item",
        preamble: { retainedText: retained },
      });
      expect(h.chatRunState.resolveBuffer("run").text).toBe(retained);
      const { sessionKey: _sessionKey, agentId: _agentId, ...wire } = payload;
      expect(Value.Check(AgentEventSchema, wire)).toBe(true);
      const { preamble: _preamble, ...legacy } = wire;
      expect(Value.Check(AgentEventSchema, legacy)).toBe(true);
      expect(
        Value.Check(AgentEventSchema, {
          ...wire,
          preamble: { retainedText: 42 },
        }),
      ).toBe(false);

      await h.emit(
        "run",
        "item",
        { kind: "preamble", itemId: "known", phase: "end", progressText: "Next check." },
        { seq: 3 },
      );
      expect(h.agent().at(-1)?.[1]).toMatchObject({
        preamble: {},
      });
      expect(h.chatRunState.resolveBuffer("run").text).toBe(retained);
    } finally {
      await h.handler.dispose();
      h.chatRunState.clear();
    }
  },
);
