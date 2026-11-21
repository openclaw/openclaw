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
import { setReplyPayloadMetadata } from "../reply-payload.js";
import { dispatchReplyFromConfig } from "./dispatch-from-config.js";
import {
  mirrorDeliveredReplyToTranscript,
  transcriptMirrorForDeliveredPayload,
} from "./dispatch-from-config.transcript.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

it.each([false, true])("retains classification and deduplicates commands: %s", async (readOnly) => {
  const state = await createOpenClawTestState({ label: "command-transcript", applyEnv: false });
  onTestFinished(() => state.cleanup());
  const storePath = state.path("sessions.json");
  const config = { session: { store: storePath } };
  const target = { agentId: "main", storePath, sessionKey: "agent:main:mattermost:channel:c1" };
  const sessionId = "selection-session";
  await upsertSessionEntry({ ...target, entry: { sessionId, updatedAt: 1 } });
  const commandText = readOnly ? "/status" : "/model openai/gpt-5.4";
  const confirmation = readOnly ? "Status: ready." : "Model set to openai/gpt-5.4.";
  const refresh = readOnly ? "Status: still ready." : "Picker refreshed.";
  const commandMetadata = readOnly ? { contextFreeCommand: true as const } : {};
  const commandId = scopeCommandTranscriptId("interaction:picker-post-1", {
    channelId: "mattermost",
    accountId: "default",
    conversationId: "channel:c1",
  });
  await mirrorDeliveredReplyToTranscript({
    cfg: config,
    metadata: transcriptMirrorForDeliveredPayload(
      {
        ...target,
        expectedSessionId: sessionId,
        commandText,
        commandId,
        idempotencyKey: "selection-confirmation",
      },
      setReplyPayloadMetadata({ text: confirmation }, commandMetadata),
    ),
  });
  expect(
    await recordDeliveredCommandExchange({
      ...target,
      config,
      expectedSessionId: sessionId,
      commandText,
      commandId,
      replyId: "picker-update",
      replyText: refresh,
      ...commandMetadata,
    }),
  ).toMatchObject({ ok: true });
  const entries = await readVisibleSessionTranscriptMessageEntries({ ...target, sessionId });
  expect(entries.map((entry) => entry.message)).toEqual(
    [
      ["user", commandText],
      ["assistant", confirmation],
      ["assistant", refresh],
    ].map(([role, text]) =>
      expect.objectContaining({
        role,
        content: [{ type: "text", text }],
        ...(readOnly
          ? {
              excludeFromContext: true,
              __openclaw: expect.objectContaining({ contextFreeCommand: true }),
            }
          : {}),
      }),
    ),
  );
  if (!readOnly) {
    for (const { message } of entries) {
      expect(message).not.toHaveProperty("excludeFromContext");
      expect(message).not.toHaveProperty("__openclaw.contextFreeCommand");
    }
  }
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
