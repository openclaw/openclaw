import { Value } from "typebox/value";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { ChatEventSchema } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { buildEmbeddedRunPayloads } from "../agents/embedded-agent-runner/run/payloads.js";
import { handleAgentEnd } from "../agents/embedded-agent-subscribe.handlers.lifecycle.js";
import { createContext } from "../agents/embedded-agent-subscribe.handlers.lifecycle.test-helpers.js";
import { createAgentHarnessAttemptLifecycle } from "../agents/harness/attempt-events.js";
import { makeAssistantMessageFixture } from "../agents/test-helpers/assistant-message-fixtures.js";
import { projectChatDisplayMessages } from "./chat-display-projection.js";
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

it("preserves exhausted context-budget guidance in live chat, Details, history, and channel replies", async () => {
  vi.useFakeTimers();
  const assistant = makeAssistantMessageFixture({
    provider: "lmstudio",
    model: "local-model",
    content: [],
    errorCode: "context_length_exceeded",
    errorMessage:
      "Context window exceeded: estimated input 35137 leaves only 0 output tokens within the 32768-token context.",
  });
  const expected =
    "Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.";
  const h = createAgentEventTestHarness({ lifecycleErrorRetryGraceMs: 0 });
  onTestFinished(() => h.handler.dispose());
  const ctx = createContext(assistant);
  const runId = ctx.params.runId;
  const sessionKey = "agent:main:main";
  h.register(runId, sessionKey, runId);
  const deliveries: Promise<void>[] = [];
  ctx.params.onAgentEvent = (event) => {
    deliveries.push(Promise.resolve(h.emit(runId, event.stream, event.data)));
  };
  await handleAgentEnd(ctx);
  await Promise.all(deliveries);

  const terminals = h.chat().filter(([, event]) => event.state !== "delta");
  expect(terminals).toHaveLength(1);
  expect(terminals[0]?.[1]).toMatchObject({
    state: "error",
    errorMessage: expected,
    errorDetail: { failoverReason: "context_overflow" },
  });
  const history = projectChatDisplayMessages([assistant]);
  expect(history).toHaveLength(1);
  expect(history[0]?.content).toEqual([{ type: "text", text: expected }]);
  expect(history[0]).not.toHaveProperty("errorMessage");
  expect(
    buildEmbeddedRunPayloads({ assistantTexts: [], lastAssistant: assistant, sessionKey }),
  ).toMatchObject([{ text: expected, isError: true }]);
});

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

it.each([
  ["thread not loaded: synthetic-thread", "Conversation context is unavailable."],
  [
    "managed worktree allocation lease core:managed-worktrees:create/capacity was lost",
    "Workspace preparation was interrupted.",
  ],
])("keeps startup recovery guidance and diagnostics in live chat: %s", async (error, title) => {
  vi.useFakeTimers();
  const h = createAgentEventTestHarness({ lifecycleErrorRetryGraceMs: 0 });
  onTestFinished(() => h.handler.dispose());
  const runId = "startup-recovery-copy";
  h.register(runId, "session-native-provider-error", runId);
  const data = { phase: "error", error, startedAt: 100, endedAt: 200 };
  await h.emit(runId, "lifecycle", data);
  const live = h.chat().find(([, event]) => event.state === "error")?.[1];

  expect(live?.errorMessage).toContain(title);
  expect(live?.errorMessage).toContain("Refresh");
  expect(live?.errorMessage).toContain(`\n\n${error}`);
});
