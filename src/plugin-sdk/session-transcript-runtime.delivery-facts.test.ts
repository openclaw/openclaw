import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLatestAssistantTextFromSessionTranscript } from "../config/sessions/transcript.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  appendSessionTranscriptMessageByIdentity,
  readLatestAssistantTextByIdentity,
  readSessionTranscriptEvents,
} from "./session-transcript-runtime.js";

describe("assistant transcript delivery projection", () => {
  let tempDir: string;
  let storePath: string;
  let state: OpenClawTestState;

  beforeEach(async () => {
    state = await createOpenClawTestState({
      prefix: "openclaw-transcript-delivery-",
      applyEnv: false,
    });
    tempDir = state.root;
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest(tempDir);
    await state.cleanup();
  });

  it.each([
    { name: "absent delivery facts", stored: undefined, projected: undefined },
    {
      name: "invalid delivery facts",
      stored: {
        replyToId: false,
        replyToCurrent: "true",
        audioAsVoice: 0,
        mediaUrls: [null, "", "   "],
        tts: "invalid",
      },
      projected: undefined,
    },
    {
      name: "persisted delivery facts",
      stored: {
        replyToId: "42",
        audioAsVoice: true,
        mediaUrls: ["/tmp/voice.ogg"],
        tts: {
          tagged: true,
          text: "Spoken answer",
          directives: [{ provider: "test", values: { voice: "synthetic" } }],
        },
      },
      projected: {
        replyToId: "42",
        audioAsVoice: true,
        mediaUrls: ["/tmp/voice.ogg"],
        tts: {
          tagged: true,
          text: "Spoken answer",
          directives: [{ provider: "test", values: { voice: "synthetic" } }],
        },
      },
    },
    {
      name: "malformed and non-delivery fields",
      stored: {
        replyToId: 42,
        replyToCurrent: true,
        audioAsVoice: "true",
        mediaUrls: [null, "", "/tmp/file.txt"],
        trustedLocalMedia: true,
        sessionWriterDeliveryAuthority: { expectedWriterRunId: "untrusted" },
        tts: { tagged: true, text: 12, directives: [{ values: { voice: 3 } }] },
      },
      projected: {
        replyToCurrent: true,
        mediaUrls: ["/tmp/file.txt"],
        tts: { tagged: true, directives: [] },
      },
    },
  ])("appends scoped messages and reads exact text with $name", async ({ stored, projected }) => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "mirror-target.jsonl"),
      sessionId: "mirror-session",
      sessionKey: "agent:main:main",
      storePath,
    };
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "    hello()\n\n" }],
      ...(stored === undefined ? {} : { openclawDelivery: stored }),
      timestamp: 1,
    };

    const appended = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message,
    });

    expect(appended).toBeDefined();
    expect(appended?.message).toMatchObject(message);
    const latest = await readLatestAssistantTextByIdentity(scope);
    expect(latest).toEqual({
      id: appended?.messageId,
      text: "    hello()\n\n",
      timestamp: 1,
      ...(projected ? { openclawDelivery: projected } : {}),
    });
    if (!projected) {
      expect(latest).not.toHaveProperty("openclawDelivery");
    }
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([
      expect.objectContaining({ type: "session" }),
      expect.objectContaining({ message: expect.objectContaining({ role: "assistant" }) }),
    ]);
  });

  it("preserves code padding and delivery facts in retained JSONL reads", async () => {
    const sessionFile = path.join(tempDir, "retained.jsonl");
    const text = "    preserved()\n\n";
    const openclawDelivery = {
      replyToCurrent: true,
      audioAsVoice: true,
      mediaUrls: ["/tmp/note.ogg"],
    };
    fs.writeFileSync(
      sessionFile,
      [
        {
          type: "message",
          id: "assistant-final",
          message: {
            role: "assistant",
            content: [{ type: "text", text }],
            timestamp: 123,
            openclawDelivery,
          },
        },
        {
          type: "message",
          id: "empty",
          message: { role: "assistant", content: [{ type: "text", text: "  \n" }], timestamp: 124 },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );

    await expect(readLatestAssistantTextFromSessionTranscript(sessionFile)).resolves.toEqual({
      id: "assistant-final",
      text,
      timestamp: 123,
      openclawDelivery,
    });
  });
});
