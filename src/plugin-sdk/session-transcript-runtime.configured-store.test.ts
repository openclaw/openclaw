import fs from "node:fs";
import { assert, describe, expect, it, afterEach, beforeEach } from "vitest";
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
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { withCodexSessionTranscriptMirrorWriteLock as withMirrorLock } from "./codex-session-transcript-runtime.js";
import { getSessionEntry, upsertSessionEntry } from "./session-store-runtime.js";
import {
  appendAssistantMirrorMessageByIdentity as appendMirror,
  appendSessionTranscriptMessageByIdentity as appendMessage,
  publishSessionTranscriptUpdateByIdentity as publishUpdate,
  readLatestAssistantTextByIdentity as readLatest,
  readSessionTranscriptEvents as readEvents,
  readSessionTranscriptRawDelta as readRawDelta,
  readSessionTranscriptVisibleMessageDelta as readVisibleDelta,
  readVisibleSessionTranscriptMessageEntries as readEntries,
  resolveSessionTranscriptTarget,
  withSessionTranscriptWriteLock as withWriteLock,
  type SessionTranscriptMessageEntry,
  type SessionTranscriptReadParams,
} from "./session-transcript-runtime.js";

const identity = { agentId: "main", sessionId: "configured", sessionKey: "agent:main:configured" };
const configuredText = "configured";
const defaultText = "competing";
const appendedText = "appended";
const message = { role: "assistant", content: appendedText };
const delivery = {
  replyToId: "42",
  audioAsVoice: true,
  mediaUrls: ["/tmp/voice.ogg"],
  tts: {
    tagged: true,
    text: "Spoken answer",
    directives: [{ provider: "test", values: { voice: "synthetic" } }],
  },
};
function assistantMessage(text: string, timestamp: number, openclawDelivery?: unknown) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp, openclawDelivery };
}
function jsonlMessage(id: string, entry: ReturnType<typeof assistantMessage>) {
  return JSON.stringify({ type: "message", id, message: entry });
}

function messageContents(events: readonly unknown[]): unknown[] {
  return events.flatMap((event) => {
    const record = event as { type?: unknown; message?: { content?: unknown } };
    return record.type === "message" ? [record.message?.content] : [];
  });
}
function assistantEntryContents(entries: readonly SessionTranscriptMessageEntry[]) {
  return entries.map(({ message: assistant }) => {
    assert(assistant.role === "assistant", `Expected assistant, got ${assistant.role}`);
    return assistant.content;
  });
}
const contents = async (scope: SessionTranscriptReadParams) =>
  messageContents(await readEvents(scope));

let state: OpenClawTestState;
let unsubscribers: Array<() => void>;
beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "openclaw-sdk-transcript-", applyEnv: false });
  unsubscribers = [];
});
afterEach(async () => {
  for (const unsubscribe of unsubscribers) {
    unsubscribe();
  }
  await state.cleanup();
});
const configFor = (storePath: string) => ({ session: { store: storePath } });
const readers: Array<(scope: SessionTranscriptReadParams) => Promise<unknown[]>> = [
  contents,
  async (scope) => {
    const page = await readRawDelta({ ...scope, maxEvents: 10, maxBytes: 10_000 });
    assert(page.kind === "page");
    return messageContents(page.events.map((row) => row.event));
  },
  async (scope) => assistantEntryContents(await readEntries(scope)),
  async (scope) => {
    const page = await readVisibleDelta({ ...scope, maxMessages: 10, maxBytes: 10_000 });
    assert(page.kind === "page");
    return assistantEntryContents(page.entries);
  },
  async (scope) => [(await readLatest(scope))?.text],
];

describe("configured SDK transcript store parity", () => {
  let configured: typeof identity & { storePath: string };
  let competing: typeof configured;
  let internalUpdates: InternalSessionTranscriptUpdate[];
  let publicUpdates: SessionTranscriptUpdate[];
  beforeEach(async () => {
    state.applyEnv();
    configured = { ...identity, storePath: state.statePath("custom", "sessions.json") };
    competing = {
      ...identity,
      storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
    };
    const config = { ...configFor(configured.storePath), plugins: { enabled: false } };
    fs.writeFileSync(state.configPath, JSON.stringify(config));
    setRuntimeConfigSnapshot(config);
    internalUpdates = [];
    publicUpdates = [];
    unsubscribers.push(
      onInternalSessionTranscriptUpdate((update) => internalUpdates.push(update)),
      onSessionTranscriptUpdate((update) => publicUpdates.push(update)),
    );
    for (const [scope, content] of [
      [configured, configuredText],
      [competing, defaultText],
    ] as const) {
      await upsertSessionEntry({ ...scope, entry: { sessionId: scope.sessionId, updatedAt: 1 } });
      await appendMessage({ ...scope, message: { role: "assistant", content, timestamp: 1 } });
    }
  });
  function expectPhysicalPublication() {
    expect(internalUpdates).toMatchObject([
      { target: { ...identity, storePath: resolveSessionTranscriptDatabasePath(configured) } },
    ]);
  }
  async function expectStores() {
    expect(await contents(configured)).toEqual([configuredText, appendedText]);
    expect(await contents(competing)).toEqual([defaultText]);
  }

  it("honors supplied configuration for projected locked appends", async () => {
    setRuntimeConfigSnapshot(configFor(competing.storePath));
    await withWriteLock(
      { ...identity, config: configFor(configured.storePath) },
      async (locked) => {
        expect(messageContents(await locked.readEvents())).toEqual([configuredText]);
        await expect(locked.appendMessage({ message })).resolves.toMatchObject({ appended: true });
        expect(messageContents(await locked.readEvents())).toEqual([configuredText, appendedText]);
      },
    );
    await expectStores();
  });

  it("honors explicit store overrides for assistant mirrors", async () => {
    await expect(
      appendMirror({ ...competing, text: appendedText, updateMode: "none" }),
    ).resolves.toMatchObject({ ok: true });
    expect(await contents(competing)).toEqual([
      defaultText,
      [{ type: "text", text: appendedText }],
    ]);
    expect(await contents(configured)).toEqual([configuredText]);
  });

  it("pins private mirror facts, committed sequences, and publication to the configured store", async () => {
    await withMirrorLock({ ...identity, env: { ...process.env } }, async (locked) => {
      expect(locked.target).not.toHaveProperty("storePath");
      expect(messageContents(await locked.readEvents())).toEqual([configuredText]);
      await Promise.resolve();
      setRuntimeConfigSnapshot(configFor(competing.storePath));
      const appended = await locked.appendMessageWithMessageSequence({
        message: { ...message, idempotencyKey: "mirror-pinned" },
      });
      expect(appended).toMatchObject({ messageSeq: 2, result: { appended: true } });
      const facts = await locked.readMessageFacts({ idempotencyKeys: ["mirror-pinned"] });
      expect(facts.existingIdempotencyKeys).toEqual(new Set(["mirror-pinned"]));
      expect(facts.messagesByIdempotencyKey.get("mirror-pinned")).toMatchObject({
        content: appendedText,
      });
      expect(messageContents(await locked.readEvents())).toEqual([configuredText, appendedText]);
      await locked.publishUpdate({ messageId: appended.result?.messageId });
      expect(internalUpdates).toEqual([]);
    });
    expectPhysicalPublication();
    expect(publicUpdates.map((update) => update.target)).toEqual([identity]);
    await expectStores();
  });

  it("publishes the configured physical store", async () => {
    await publishUpdate(identity);
    expectPhysicalPublication();
  });

  it("reads the configured store while rejecting mismatched read-fence keys and stores", async () => {
    const projectedTarget = await resolveSessionTranscriptTarget(identity);
    expect(projectedTarget).toEqual({
      ...identity,
      memoryKey: "transcript:main:configured",
      targetKind: "runtime-session",
    });
    const admitted = await appendMessage({
      ...configured,
      message: { role: "user", content: "admitted turn" },
    });
    assert(admitted?.anchor, "expected admission anchor");
    await runWithSessionTranscriptReadFence(
      { ...admitted.anchor, logicalTurnId: "configured-read-fence", role: "user" },
      async () => {
        for (const read of readers) {
          expect(await read(identity)).toEqual([configuredText]);
          expect(await read(projectedTarget)).toEqual([configuredText]);
          await expect(
            read({ ...identity, sessionKey: "agent:main:wrong-key" }),
          ).rejects.toBeInstanceOf(SessionTranscriptReadFenceError);
          await expect(read(competing)).rejects.toBeInstanceOf(SessionTranscriptReadFenceError);
        }
      },
    );
  });

  it("keeps transcript-only writes and rejects reassignment to another key", async () => {
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
      appendMessage({ ...configured, sessionKey: "agent:main:wrong-owner", message }),
    ).rejects.toThrow("is owned by");
  });
});

describe("assistant transcript delivery projection", () => {
  it.each([
    { name: "delivery facts", stored: structuredClone(delivery), projected: delivery },
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
      sessionFile: state.path("mirror-target.jsonl"),
      sessionId: "mirror-session",
      sessionKey: "agent:main:main",
      storePath: state.path("sessions.json"),
    };
    const deliveredMessage = assistantMessage("    hello()\n\n", 1, stored);

    const appended = await appendMessage({ ...scope, message: deliveredMessage });

    expect(appended).toBeDefined();
    expect(appended?.message).toMatchObject(deliveredMessage);
    await expect(readLatest(scope)).resolves.toEqual({
      id: appended?.messageId,
      text: "    hello()\n\n",
      timestamp: 1,
      openclawDelivery: projected,
    });
    await expect(readEvents(scope)).resolves.toEqual([
      expect.objectContaining({ type: "session" }),
      expect.objectContaining({ message: expect.objectContaining({ role: "assistant" }) }),
    ]);
  });

  it("preserves code padding and delivery facts in retained JSONL reads", async () => {
    const sessionFile = state.path("retained.jsonl");
    const text = "    preserved()\n\n";
    const openclawDelivery = {
      replyToCurrent: true,
      audioAsVoice: true,
      mediaUrls: ["/tmp/note.ogg"],
    };
    fs.writeFileSync(
      sessionFile,
      [
        jsonlMessage("assistant-final", assistantMessage(text, 123, openclawDelivery)),
        jsonlMessage("empty", assistantMessage("  \n", 124)),
      ].join("\n") + "\n",
    );

    await expect(readLatestAssistantTextFromSessionTranscript(sessionFile)).resolves.toEqual({
      id: "assistant-final",
      text,
      timestamp: 123,
      openclawDelivery,
    });
  });
});
