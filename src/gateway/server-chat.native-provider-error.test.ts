import { Value } from "typebox/value";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { ChatEventSchema } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { createAgentHarnessAttemptLifecycle } from "../agents/harness/attempt-events.js";
import { createAgentEventTestHarness } from "./server-chat.agent-events.test-harness.js";

// mock-isolation: Native lifecycle projection must not read an operator's session store.
vi.mock("./session-utils.js", () => {
  const loadSessionEntry = vi.fn(() => ({
    cfg: {},
    storePath: "/tmp/native-provider-error-sessions.json",
    store: {},
    entry: undefined,
    canonicalKey: "session-native-provider-error",
    storeKeys: ["session-native-provider-error"],
  }));
  return { loadSessionEntry, loadGatewaySessionEntryReadOnly: loadSessionEntry };
});

afterEach(() => vi.useRealTimers());

it.each([false, true])(
  "publishes native provider failures without treating them as cancellation (aborted=%s)",
  async (aborted) => {
    vi.useFakeTimers();
    const runId = "run-native-provider-error";
    const h = createAgentEventTestHarness({ lifecycleErrorRetryGraceMs: 0 });
    onTestFinished(() => h.handler.dispose());
    h.register(runId, "session-native-provider-error", runId);
    let seq = 0;
    const deliveries: Promise<void>[] = [];
    const lifecycle = createAgentHarnessAttemptLifecycle({
      attempt: { provider: "openai", modelId: "gpt-5.6-luna" },
      backend: "codex-app-server",
      startedAtMs: Date.now(),
      state: { lifecycleStarted: false, lifecycleTerminalEmitted: false },
      emitEvent: (event) => {
        const delivery = Promise.resolve(h.emit(runId, event.stream, event.data, { seq: ++seq }));
        deliveries.push(delivery);
        return delivery;
      },
    });
    lifecycle.emitLifecycleStart({ provider: "openai", model: "gpt-5.6-luna" });
    lifecycle.emitLifecycleTerminal({
      phase: "error",
      error: "Selected model is at capacity. Please try a different model.",
      aborted,
      stopReason: aborted ? "stop" : "error",
      replayInvalid: true,
    });
    await Promise.all(deliveries);

    const terminals = h.chat().filter(([, event]) => event.state !== "delta");
    expect(terminals).toHaveLength(1);
    const wirePayload = JSON.stringify(terminals[0]?.[1]);
    const payload = JSON.parse(wirePayload);
    expect(Value.Check(ChatEventSchema, payload)).toBe(true);
    expect(payload).toMatchObject({ runId, state: aborted ? "aborted" : "error" });
    if (aborted) {
      expect(payload.errorKind).toBeUndefined();
      expect(payload.errorDetail).toBeUndefined();
    } else {
      expect(payload).toMatchObject({
        errorMessage: "⚠️ Selected model is at capacity. Try a different model, or wait and retry.",
        errorKind: "rate_limit",
        errorDetail: {
          provider: "openai",
          model: "gpt-5.6-luna",
          failoverReason: "overloaded",
        },
      });
    }
    expect(h.agent().at(-1)?.[1]).toMatchObject({
      stream: "lifecycle",
      data: { phase: "error", aborted, replayInvalid: true },
    });
  },
);
