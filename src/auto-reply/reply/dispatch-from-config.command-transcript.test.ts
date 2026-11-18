import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, onTestFinished } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  recordDeliveredCommandExchange,
  scopeCommandTranscriptId,
} from "../../config/sessions/command-transcript.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import { readVisibleSessionTranscriptMessageEntries } from "../../plugin-sdk/session-transcript-runtime.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
import { dispatchReplyFromConfig } from "./dispatch-from-config.js";
import { mirrorDeliveredReplyToTranscript } from "./dispatch-from-config.transcript.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

it("persists one selection command for its dispatch confirmation and native picker refresh", async () => {
  const state = await createOpenClawTestState({ label: "mattermost-selection", applyEnv: false });
  onTestFinished(() => state.cleanup());
  const storePath = state.path("sessions.json");
  const config = { session: { store: storePath } };
  const sessionKey = "agent:main:mattermost:channel:channel-1";
  const sessionId = "selection-session";
  await upsertSessionEntry({
    agentId: "main",
    storePath,
    sessionKey,
    entry: { sessionId, updatedAt: 1 },
  });
  const commandId = scopeCommandTranscriptId("interaction:picker-post-1:select:openai/gpt-5.4", {
    channelId: "mattermost",
    accountId: "default",
    conversationId: "channel:channel-1",
  });
  await mirrorDeliveredReplyToTranscript({
    cfg: config,
    metadata: {
      agentId: "main",
      sessionKey,
      expectedSessionId: sessionId,
      storePath,
      text: "Model set to openai/gpt-5.4.",
      commandText: "/model openai/gpt-5.4",
      commandId,
      idempotencyKey: "selection-confirmation",
    },
  });
  expect(
    await recordDeliveredCommandExchange({
      config,
      agentId: "main",
      sessionKey,
      expectedSessionId: sessionId,
      storePath,
      commandText: "/model openai/gpt-5.4",
      commandId,
      replyId: "picker-update",
      replyText: "Select a model to switch immediately.\ngpt-5.4 [current]\nBack to providers",
    }),
  ).toMatchObject({ ok: true });
  const entries = await readVisibleSessionTranscriptMessageEntries({
    agentId: "main",
    storePath,
    sessionKey,
    sessionId,
  });
  expect(entries.map((entry) => entry.message)).toEqual([
    expect.objectContaining({
      role: "user",
      content: [{ type: "text", text: "/model openai/gpt-5.4" }],
    }),
    expect.objectContaining({
      role: "assistant",
      content: expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "Model set to openai/gpt-5.4." }),
      ]),
    }),
    expect.objectContaining({
      role: "assistant",
      content: expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: "Select a model to switch immediately.\ngpt-5.4 [current]\nBack to providers",
        }),
      ]),
    }),
  ]);
});

it.each([false, true])(
  "records a late-delivered /stop before the next turn's row (active run: %s)",
  async (active) => {
    const state = await createOpenClawTestState({ label: "stop-transcript", applyEnv: false });
    onTestFinished(() => state.cleanup());
    const storePath = state.path("sessions.json");
    const sessionKey = "agent:main:telegram:direct:1001";
    const target = { agentId: "main", storePath, sessionKey, sessionId: "stop-session" };
    await upsertSessionEntry({ ...target, entry: { sessionId: target.sessionId, updatedAt: 1 } });
    const persisted = createDeferred();
    let started = false;
    let rowsAtStart: number | undefined;
    let next: Promise<void> | undefined;
    const startNextTurn = () => {
      next = withSessionTurn(target, async () => {
        started = true;
        rowsAtStart = (await readVisibleSessionTranscriptMessageEntries(target)).length;
        await appendAssistantMessageToSessionTranscript({
          ...target,
          expectedSessionId: target.sessionId,
          idempotencyKey: "next-turn",
          text: "Next turn",
        });
        persisted.resolve();
      });
    };
    if (active) {
      const operation = createReplyOperation({
        agentId: "main",
        sessionKey,
        sessionId: target.sessionId,
        target: captureSessionTarget({
          agentId: "main",
          sessionKey,
          storeScope: storePath,
          incarnation: target.sessionId,
        }),
        resetTriggered: false,
      });
      operation.attachBackend({
        kind: "embedded",
        isStreaming: () => true,
        // Input accepted after Stop's selection waits for the stopped run to clear.
        cancel: () => {
          startNextTurn();
          queueMicrotask(() => operation.complete());
        },
      });
      operation.setPhase("running");
    }
    const delivering = createDeferred();
    const releaseDelivery = createDeferred();
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        delivering.resolve();
        await releaseDelivery.promise;
        return { visibleReplySent: true };
      },
    });
    const stop = withReplyDispatcher({
      dispatcher,
      run: () =>
        dispatchReplyFromConfig({
          cfg: { session: { store: storePath } },
          dispatcher,
          ctx: {
            Body: "/stop",
            CommandBody: "/stop",
            CommandAuthorized: true,
            Provider: "telegram",
            Surface: "telegram",
            ChatType: "direct",
            From: "telegram:1001",
            To: "telegram:2002",
            SessionKey: sessionKey,
            MessageSid: `stop-${String(active)}`,
          },
        }),
    });
    await delivering.promise;
    if (!active) {
      startNextTurn();
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    // A turn admitted while the ack is still in flight writes ahead of the Stop's exchange.
    if (started) {
      await persisted.promise;
    }
    releaseDelivery.resolve();
    await Promise.all([stop, next]);
    const entries = await readVisibleSessionTranscriptMessageEntries(target);
    expect(
      entries.map(({ message }) => String(Reflect.get(message, "idempotencyKey")).split(":")[0]),
    ).toEqual(["command-input", "command-reply", "next-turn"]);
    // The next turn starts only after the exchange is recorded, not merely delivered.
    expect(rowsAtStart).toBe(2);
  },
);
