import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import { resolveSessionTranscriptDatabasePath } from "../config/sessions/session-accessor.js";
import {
  runWithSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "../config/sessions/session-transcript-read-fence.js";
import { readLatestAssistantTextFromSessionTranscript } from "../config/sessions/transcript.js";
import {
  onInternalSessionTranscriptUpdate,
  onSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
  type SessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { withCodexSessionTranscriptMirrorWriteLock as withMirrorLock } from "./codex-session-transcript-runtime.js";
import { getSessionEntry, upsertSessionEntry } from "./session-store-runtime.js";
import {
  appendAssistantMirrorMessageByIdentity as appendMirror,
  appendSessionTranscriptMessageByIdentity as appendMessage,
  publishSessionTranscriptUpdateByIdentity as publishUpdate,
  readLatestAssistantTextByIdentity,
  readSessionTranscriptEvents,
  readSessionTranscriptRawDelta,
  readSessionTranscriptVisibleMessageDelta,
  readVisibleSessionTranscriptMessageEntries,
  resolveSessionTranscriptTarget,
  withSessionTranscriptWriteLock as withWriteLock,
  type SessionTranscriptMessageEntry,
  type SessionTranscriptReadParams,
  appendSessionTranscriptMessageByIdentity,
} from "./session-transcript-runtime.js";

const identity = {
  agentId: "main",
  sessionId: "configured-store-session",
  sessionKey: "agent:main:configured-store",
};
const configuredText = "Message from the configured store";
const defaultText = "Competing message with the same session id";
const appendedText = "Appended through the SDK";
const message = { role: "assistant", content: appendedText };

function messageContents(events: readonly unknown[]): unknown[] {
  return events.flatMap((event) => {
    const record = event as { type?: unknown; message?: { content?: unknown } };
    return record.type === "message" ? [record.message?.content] : [];
  });
}
function assistantEntryContents(entries: readonly SessionTranscriptMessageEntry[]) {
  return entries.map(({ message: assistant }) => {
    if (assistant.role !== "assistant") {
      throw new Error(`Expected assistant, got ${assistant.role}`);
    }
    return assistant.content;
  });
}
const contents = async (scope: SessionTranscriptReadParams) =>
  messageContents(await readSessionTranscriptEvents(scope));

async function withConfiguredStores(
  run: (stores: {
    configured: typeof identity & { storePath: string };
    competing: typeof identity & { storePath: string };
    internalUpdates: InternalSessionTranscriptUpdate[];
    publicUpdates: SessionTranscriptUpdate[];
  }) => Promise<void>,
) {
  await withOpenClawTestState({ prefix: "openclaw-sdk-configured-store-" }, async (state) => {
    const configured = { ...identity, storePath: state.statePath("custom", "sessions.json") };
    const competing = {
      ...identity,
      storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
    };
    const config = { session: { store: configured.storePath }, plugins: { enabled: false } };
    fs.writeFileSync(state.configPath, JSON.stringify(config));
    setRuntimeConfigSnapshot(config);
    const internalUpdates: InternalSessionTranscriptUpdate[] = [];
    const publicUpdates: SessionTranscriptUpdate[] = [];
    const offInternal = onInternalSessionTranscriptUpdate((update) => internalUpdates.push(update));
    const offPublic = onSessionTranscriptUpdate((update) => publicUpdates.push(update));
    try {
      for (const [scope, content] of [
        [configured, configuredText],
        [competing, defaultText],
      ] as const) {
        await upsertSessionEntry({ ...scope, entry: { sessionId: scope.sessionId, updatedAt: 1 } });
        await appendMessage({ ...scope, message: { role: "assistant", content, timestamp: 1 } });
      }
      await run({ configured, competing, internalUpdates, publicUpdates });
    } finally {
      offInternal();
      offPublic();
    }
  });
}
const readers: Array<(scope: SessionTranscriptReadParams) => Promise<unknown[]>> = [
  contents,
  async (scope) => {
    const page = await readSessionTranscriptRawDelta({ ...scope, maxEvents: 10, maxBytes: 10_000 });
    expect(page.kind).toBe("page");
    return page.kind === "page" ? messageContents(page.events.map((row) => row.event)) : [];
  },
  async (scope) => assistantEntryContents(await readVisibleSessionTranscriptMessageEntries(scope)),
  async (scope) => {
    const page = await readSessionTranscriptVisibleMessageDelta({
      ...scope,
      maxMessages: 10,
      maxBytes: 10_000,
    });
    expect(page.kind).toBe("page");
    return page.kind === "page" ? assistantEntryContents(page.entries) : [];
  },
  async (scope) => [(await readLatestAssistantTextByIdentity(scope))?.text],
];

describe("configured SDK transcript store parity", () => {
  it("honors supplied configuration for projected locked appends", async () => {
    await withConfiguredStores(async ({ configured, competing }) => {
      setRuntimeConfigSnapshot({ session: { store: competing.storePath } });
      await withWriteLock(
        { ...identity, config: { session: { store: configured.storePath } } },
        async (locked) => {
          expect(messageContents(await locked.readEvents())).toEqual([configuredText]);
          await expect(locked.appendMessage({ message })).resolves.toMatchObject({
            appended: true,
          });
          expect(messageContents(await locked.readEvents())).toEqual([
            configuredText,
            appendedText,
          ]);
        },
      );
      expect(await contents(competing)).toEqual([defaultText]);
      expect(await contents(configured)).toEqual([configuredText, appendedText]);
    });
  });

  it("honors explicit store overrides for assistant mirrors", async () => {
    await withConfiguredStores(async ({ configured, competing }) => {
      await expect(
        appendMirror({
          ...competing,
          text: appendedText,
          updateMode: "none",
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(await contents(competing)).toEqual([
        defaultText,
        [{ type: "text", text: appendedText }],
      ]);
      expect(await contents(configured)).toEqual([configuredText]);
    });
  });

  it("pins private mirror facts, committed sequences, and publication to the configured store", async () => {
    await withConfiguredStores(
      async ({ configured, competing, internalUpdates, publicUpdates }) => {
        await withMirrorLock({ ...identity, env: { ...process.env } }, async (locked) => {
          expect(locked.target).not.toHaveProperty("storePath");
          expect(messageContents(await locked.readEvents())).toEqual([configuredText]);
          await Promise.resolve();
          setRuntimeConfigSnapshot({ session: { store: competing.storePath } });
          const appended = await locked.appendMessageWithMessageSequence({
            message: { ...message, idempotencyKey: "mirror-pinned" },
          });
          expect(appended).toMatchObject({ messageSeq: 2, result: { appended: true } });
          const facts = await locked.readMessageFacts({ idempotencyKeys: ["mirror-pinned"] });
          expect(facts.existingIdempotencyKeys).toEqual(new Set(["mirror-pinned"]));
          expect(facts.messagesByIdempotencyKey.get("mirror-pinned")).toMatchObject({
            content: appendedText,
          });
          expect(messageContents(await locked.readEvents())).toEqual([
            configuredText,
            appendedText,
          ]);
          await locked.publishUpdate({ messageId: appended.result?.messageId });
          expect(internalUpdates).toEqual([]);
        });
        expect(internalUpdates).toMatchObject([
          { target: { ...identity, storePath: resolveSessionTranscriptDatabasePath(configured) } },
        ]);
        expect(publicUpdates.map((update) => update.target)).toEqual([identity]);
        expect(await contents(configured)).toEqual([configuredText, appendedText]);
        expect(await contents(competing)).toEqual([defaultText]);
      },
    );
  });

  it("publishes the configured physical store", async () => {
    await withConfiguredStores(async ({ configured, internalUpdates }) => {
      await publishUpdate(identity);
      expect(internalUpdates).toMatchObject([
        { target: { ...identity, storePath: resolveSessionTranscriptDatabasePath(configured) } },
      ]);
    });
  });

  it("reads the configured store while rejecting mismatched read-fence keys and stores", async () => {
    await withConfiguredStores(async ({ configured, competing }) => {
      const projectedTarget = await resolveSessionTranscriptTarget(identity);
      expect(projectedTarget).toEqual({
        ...identity,
        memoryKey: "transcript:main:configured-store-session",
        targetKind: "runtime-session",
      });
      const admitted = await appendMessage({
        ...configured,
        message: { role: "user", content: "admitted turn" },
      });
      if (!admitted?.anchor) {
        throw new Error("expected admission anchor");
      }
      const receipt = {
        ...admitted.anchor,
        logicalTurnId: "configured-read-fence",
        role: "user" as const,
      };
      await runWithSessionTranscriptReadFence(receipt, async () => {
        for (const read of readers) {
          expect(await read(identity)).toEqual([configuredText]);
          expect(await read(projectedTarget)).toEqual([configuredText]);
          await expect(
            read({ ...identity, sessionKey: "agent:main:wrong-key" }),
          ).rejects.toBeInstanceOf(SessionTranscriptReadFenceError);
          await expect(read(competing)).rejects.toBeInstanceOf(SessionTranscriptReadFenceError);
        }
      });
    });
  });

  it("keeps transcript-only writes and rejects reassignment to another key", async () => {
    await withConfiguredStores(async ({ configured }) => {
      const transcriptOnly = {
        ...identity,
        sessionId: "transcript-only",
        sessionKey: "agent:main:transcript-only",
      };
      await appendMessage({ ...transcriptOnly, message });
      const stored = { ...transcriptOnly, storePath: configured.storePath };
      expect(await contents(stored)).toEqual([appendedText]);
      expect(getSessionEntry(stored)).toBeUndefined();
      await expect(
        appendMessage({
          ...configured,
          sessionKey: "agent:main:wrong-owner",
          message,
        }),
      ).rejects.toThrow("is owned by");
    });
  });
});

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
    const deliveredMessage = {
      role: "assistant",
      content: [{ type: "text", text: "    hello()\n\n" }],
      openclawDelivery: stored,
      timestamp: 1,
    };

    const appended = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: deliveredMessage,
    });

    expect(appended).toBeDefined();
    expect(appended?.message).toMatchObject(deliveredMessage);
    const latest = await readLatestAssistantTextByIdentity(scope);
    expect(latest).toEqual({
      id: appended?.messageId,
      text: "    hello()\n\n",
      timestamp: 1,
      openclawDelivery: projected,
    });
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
