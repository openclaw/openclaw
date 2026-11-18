import { setImmediate } from "node:timers/promises";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, onTestFinished } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  recordDeliveredCommandExchange,
  scopeCommandTranscriptId,
} from "../../config/sessions/command-transcript.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import { readVisibleSessionTranscriptMessageEntries } from "../../plugin-sdk/session-transcript-runtime.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
import { dispatchReplyFromConfig } from "./dispatch-from-config.js";
import { mirrorDeliveredReplyToTranscript } from "./dispatch-from-config.transcript.js";
import { REPLY_ADMISSION_TICKET, reserveReplyAdmissionTicket } from "./reply-admission-ticket.js";
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

it("records a late-delivered /stop before admitting the next message", async () => {
  const state = await createOpenClawTestState({ label: "stop-transcript", applyEnv: false });
  onTestFinished(() => state.cleanup());
  const storePath = state.path("sessions.json");
  const sessionKey = "agent:main:telegram:direct:1001";
  const sessionId = "stop-session";
  const target = { agentId: "main", storePath, sessionKey, sessionId };
  await upsertSessionEntry({ ...target, entry: { sessionId, updatedAt: 1 } });
  const delivering = createDeferred();
  const releaseDelivery = createDeferred();
  const stopDispatched = createDeferred();
  const cfg = { session: { store: storePath } };
  const ctx = {
    CommandAuthorized: true,
    Provider: "telegram",
    Surface: "telegram",
    ChatType: "direct",
    From: "telegram:1001",
    To: "telegram:2002",
    SessionKey: sessionKey,
  };
  const dispatcher = createReplyDispatcher({
    deliver: async () => {
      delivering.resolve();
      await releaseDelivery.promise;
      return { visibleReplySent: true };
    },
  });
  const stop = withReplyDispatcher({
    dispatcher,
    run: async () => {
      const result = await dispatchReplyFromConfig({
        cfg,
        dispatcher,
        ctx: { ...ctx, Body: "/stop", CommandBody: "/stop", MessageSid: "stop" },
      });
      stopDispatched.resolve();
      return result;
    },
  });
  let next: Promise<unknown> | undefined;
  try {
    await Promise.race([Promise.all([stopDispatched.promise, delivering.promise]), stop]);
    const nextPersisted = createDeferred();
    const waiting = createDeferred();
    const ticket = reserveReplyAdmissionTicket([sessionKey])!;
    let admitted = false;
    const nextDispatcher = createReplyDispatcher({ deliver: async () => {} });
    next = withReplyDispatcher({
      dispatcher: nextDispatcher,
      run: () =>
        dispatchReplyFromConfig({
          cfg,
          dispatcher: nextDispatcher,
          ctx: { ...ctx, Body: "next message", MessageSid: "next" },
          replyOptions: {
            [REPLY_ADMISSION_TICKET]: {
              ...ticket,
              async wait(signal) {
                waiting.resolve();
                admitted = await ticket.wait(signal);
                return admitted;
              },
            },
          },
          replyResolver: async () => {
            expect(
              await appendAssistantMessageToSessionTranscript({
                ...target,
                expectedSessionId: sessionId,
                idempotencyKey: "next-turn",
                text: "Next turn",
              }),
            ).toMatchObject({ ok: true });
            nextPersisted.resolve();
            return undefined;
          },
        }),
    }).finally(() => ticket.release());
    await awaitGateBeforeSettlement(
      waiting.promise,
      next,
      "follow-up skipped its admission ticket",
    );
    await setImmediate();
    // The unblocked baseline always gets to persist ahead of Stop's acknowledgement.
    if (admitted) {
      await awaitGateBeforeSettlement(nextPersisted.promise, next, "follow-up did not persist");
    }
  } finally {
    releaseDelivery.resolve();
    await Promise.all([stop, next]);
  }
  const entries = await readVisibleSessionTranscriptMessageEntries(target);
  expect(
    entries.map(({ message }) => String(Reflect.get(message, "idempotencyKey")).split(":")[0]),
  ).toEqual(["command-input", "command-reply", "next-turn"]);
});
