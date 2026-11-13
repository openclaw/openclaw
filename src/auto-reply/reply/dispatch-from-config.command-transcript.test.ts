import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, onTestFinished } from "vitest";
import {
  recordDeliveredCommandExchange,
  scopeCommandTranscriptId,
} from "../../config/sessions/command-transcript.js";
import { readVisibleSessionTranscriptMessageEntries } from "../../plugin-sdk/session-transcript-runtime.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import {
  mirrorDeliveredReplyToTranscript,
  transcriptMirrorForDeliveredPayload,
} from "./dispatch-from-config.transcript.js";

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
