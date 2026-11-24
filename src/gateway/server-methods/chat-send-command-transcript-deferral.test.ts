import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { readVisibleSessionTranscriptMessageEntries } from "../../plugin-sdk/session-transcript-runtime.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { markReplyOperationExecutionStarted } from "../../sessions/session-controller.state.js";
import { testing as controllerTesting } from "../../sessions/session-controller.test-support.js";
import {
  deferCommandTranscriptWrite,
  shouldDeferCommandTranscript,
} from "./chat-send-command-transcript-deferral.js";

afterEach(() => controllerTesting.resetSessionControllerForTest());

const commandPayload = () =>
  setReplyPayloadMetadata({ text: "Thinking level set to ultra." }, { commandReply: true });

it("records a mid-turn command exchange only after the active turn settles", async () => {
  const state = await createOpenClawTestState({
    label: "gateway-command-deferral",
    applyEnv: false,
  });
  onTestFinished(() => state.cleanup());
  const storePath = state.path("sessions.json");
  const sessionKey = "agent:main:webchat:deferred-ack";
  const target = { agentId: "main", storePath, sessionKey };
  const sessionId = "busy-session";
  await upsertSessionEntry({ ...target, entry: { sessionId, updatedAt: 1 } });
  const scope = { ...target, sessionId };
  await replaceTranscriptEvents(scope, [{ type: "session", version: 3, id: sessionId }]);
  const read = async () =>
    (await readVisibleSessionTranscriptMessageEntries({ ...target, sessionId })).map(
      (entry) => entry.message,
    );

  const [started, finish] = [createDeferred(), createDeferred()];
  const turn = withSessionTurn(
    { sessionKey, sessionId, storePath, agentId: "main" },
    async (operation) => {
      markReplyOperationExecutionStarted(operation!);
      started.resolve();
      await finish.promise;
    },
  );
  await started.promise;

  expect(
    shouldDeferCommandTranscript({
      runtimeOwnsTranscript: false,
      sessionKey,
      payloads: [commandPayload()],
    }),
  ).toBe(true);

  const writes: string[] = [];
  deferCommandTranscriptWrite({
    sessionKey,
    write: async () => {
      writes.push("user");
      await appendTranscriptMessage(scope, {
        eventId: "command-input",
        message: { role: "user", content: [{ type: "text", text: "/think ultra" }] },
      });
      writes.push("assistant");
      await appendTranscriptMessage(scope, {
        eventId: "command-ack",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Thinking level set to ultra." }],
        },
      });
    },
  });

  // The running turn's model-context fence stays untouched while it works.
  await vi.waitFor(() => expect(writes).toEqual([]));
  expect(await read()).toEqual([]);

  finish.resolve();
  await turn;
  await vi.waitFor(async () => expect(await read()).toHaveLength(2), { timeout: 15_000 });
  const messages = await read();
  expect(messages).toEqual([
    expect.objectContaining({ role: "user", content: [{ type: "text", text: "/think ultra" }] }),
    expect.objectContaining({
      role: "assistant",
      content: [{ type: "text", text: "Thinking level set to ultra." }],
    }),
  ]);
  for (const message of messages) {
    expect(message).not.toHaveProperty("excludeFromContext");
  }
});

it("keeps an idle command exchange inline", () => {
  expect(
    shouldDeferCommandTranscript({
      runtimeOwnsTranscript: false,
      sessionKey: "agent:main:webchat:idle-ack",
      payloads: [commandPayload()],
    }),
  ).toBe(false);
});

it("does not defer ordinary replies or runtime-owned transcripts", async () => {
  expect(
    shouldDeferCommandTranscript({
      runtimeOwnsTranscript: false,
      sessionKey: "agent:main:webchat:ordinary",
      payloads: [{ text: "ordinary answer" }],
    }),
  ).toBe(false);

  const [started, finish] = [createDeferred(), createDeferred()];
  const turn = withSessionTurn(
    { sessionKey: "agent:main:webchat:runtime", sessionId: "runtime-session", agentId: "main" },
    async (operation) => {
      markReplyOperationExecutionStarted(operation!);
      started.resolve();
      await finish.promise;
    },
  );
  await started.promise;
  expect(
    shouldDeferCommandTranscript({
      runtimeOwnsTranscript: true,
      sessionKey: "agent:main:webchat:runtime",
      payloads: [commandPayload()],
    }),
  ).toBe(false);
  finish.resolve();
  await turn;
});
