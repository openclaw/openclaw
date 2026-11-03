import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, onTestFinished } from "vitest";
import {
  recordDeliveredCommandExchange,
  scopeCommandTranscriptId,
} from "../../config/sessions/command-transcript.js";
import { readVisibleSessionTranscriptMessageEntries } from "../../plugin-sdk/session-transcript-runtime.js";
import { mirrorDeliveredReplyToTranscript } from "./dispatch-from-config.transcript.js";

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
