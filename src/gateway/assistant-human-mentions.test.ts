import { expect, it, vi } from "vitest";
import { loadSessionEntry, loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { injectAssistantMessageWithHumanMentions } from "./assistant-human-mentions.js";
import { SESSION_ID, SESSION_KEY, withMentionInbox } from "./mention-inbox.test-support.js";
import { injectGatewayAssistantMessage } from "./server-methods/chat-inject.js";

const transcriptAppend = vi.hoisted(() => ({ entered: false }));
vi.mock("./server-methods/chat-transcript-inject.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./server-methods/chat-transcript-inject.js")>();
  return {
    ...actual,
    appendInjectedAssistantMessageToTranscript: (
      ...args: Parameters<typeof actual.appendInjectedAssistantMessageToTranscript>
    ) => {
      transcriptAppend.entered = true;
      return actual.appendInjectedAssistantMessageToTranscript(...args);
    },
  };
});

type Fixture = Parameters<Parameters<typeof withMentionInbox>[0]>[0];
const scope = { agentId: "main", sessionKey: SESSION_KEY };
const TEXT = "Welcome! @Bob invited you.";

const contextFor = (f: Fixture) => ({
  getRuntimeConfig: () => ({}),
  broadcast: vi.fn(),
  nodeSendToSession: vi.fn(),
  mentionInbox: f.inbox,
});

function insert(f: Fixture, overrides: Record<string, unknown> = {}, guard?: () => void) {
  const context = contextFor(f);
  const result = injectAssistantMessageWithHumanMentions(
    context,
    {
      sessionKey: SESSION_KEY,
      agentId: "main",
      text: TEXT,
      mentions: [{ profileId: f.bob.id, start: 9, end: 13 }],
      onBehalfOfProfileId: f.alice.id,
      idempotencyKey: "welcome:invitation-1",
      ...overrides,
    },
    guard,
  );
  return { context, result };
}

async function assistantRows() {
  const events = await loadTranscriptEvents({ ...scope, sessionId: SESSION_ID });
  return events.flatMap((event) => {
    const message = (event as { message?: { role?: string } }).message;
    return message?.role === "assistant" ? [message] : [];
  });
}

it("records one Inbox mention and involvement for a Gateway-authored assistant message", () =>
  withMentionInbox(async (f) => {
    const text = `${TEXT} Please test [[audio_as_voice]] replies.`;
    const first = insert(f, { text });
    const inserted = await first.result;
    expect(inserted).toMatchObject({ ok: true, value: { messageId: expect.any(String) } });
    expect(first.context.broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        message: expect.objectContaining({
          __openclaw: { humanMentions: [{ profileId: f.bob.id, start: 9, end: 13 }] },
        }),
      }),
      expect.anything(),
    );
    expect(await assistantRows()).toMatchObject([
      {
        role: "assistant",
        content: [{ type: "text", text }],
        __openclaw: { humanMentions: [{ profileId: f.bob.id, start: 9, end: 13 }] },
      },
    ]);
    const items = await f.items();
    expect(items).toMatchObject([
      {
        senderProfileId: f.alice.id,
        sessionKey: SESSION_KEY,
        messageId: inserted.ok ? inserted.value.messageId : "",
        excerpt: text,
      },
    ]);
    expect(loadSessionEntry(scope)?.profileInvolvement?.profiles[f.bob.id]).toMatchObject({
      hidden: false,
      lastMention: expect.any(Object),
    });
    expect(f.push).toHaveBeenCalledOnce();

    // A retry after success, or after an interrupted delivery, replays the same row.
    const retry = insert(f, { text });
    expect(await retry.result).toMatchObject({ ok: true, value: { replayed: true } });
    expect(retry.context.broadcast).not.toHaveBeenCalled();
    expect(await assistantRows()).toHaveLength(1);
    expect(await f.items()).toEqual(items);
    expect(f.push).toHaveBeenCalledOnce();
  }));

it("rechecks caller authority at the transcript commit, after the append started", () =>
  withMentionInbox(async (f) => {
    transcriptAppend.entered = false;
    // Authority ends while the append waits for its target: no row and no Inbox entry.
    const guard = () => {
      if (transcriptAppend.entered) {
        throw new Error("Visitor access ended");
      }
    };
    const result = await insert(f, {}, guard).result;
    expect(transcriptAppend.entered).toBe(true);
    expect(result.ok).toBe(false);
    expect(await assistantRows()).toEqual([]);
    expect(await f.items()).toEqual([]);
  }));

it("finishes an interrupted Inbox delivery on retry", () =>
  withMentionInbox(async (f) => {
    // The row committed, but the process stopped before Inbox delivery.
    const interrupted = await injectGatewayAssistantMessage(contextFor(f), {
      sessionKey: SESSION_KEY,
      agentId: "main",
      message: TEXT,
      idempotencyKey: "assistant-mention:welcome:invitation-1",
      humanMentions: [{ profileId: f.bob.id, start: 9, end: 13 }],
    });
    expect(interrupted.ok).toBe(true);
    expect(await f.items()).toEqual([]);
    expect(await insert(f).result).toMatchObject({ ok: true, value: { replayed: true } });
    expect(await assistantRows()).toHaveLength(1);
    expect(await f.items()).toMatchObject([{ senderProfileId: f.alice.id, excerpt: TEXT }]);
  }));

it("keeps the message but skips the Inbox when the recipient cannot read the session", () =>
  withMentionInbox(async (f) => {
    await f.setSession({ visibility: "draft" });
    expect(await insert(f).result).toMatchObject({ ok: true });
    expect(await assistantRows()).toHaveLength(1);
    expect(await f.items()).toEqual([]);
    expect(loadSessionEntry(scope)).not.toHaveProperty("profileInvolvement");
  }));

it.each([
  ["self-mention", (f: Fixture) => ({ onBehalfOfProfileId: f.bob.id })],
  [
    "span without an @label",
    (f: Fixture) => ({ mentions: [{ profileId: f.bob.id, start: 0, end: 7 }] }),
  ],
  ["no mentions", () => ({ mentions: [] })],
  ["untrimmed text", () => ({ text: ` ${TEXT}` })],
  ["missing idempotency key", () => ({ idempotencyKey: " " })],
  ["incognito session", () => ({ sessionKey: "agent:main:dashboard:incognito-welcome" })],
])("rejects %s before writing", (_name, overrides) =>
  withMentionInbox(async (f) => {
    expect(await insert(f, overrides(f)).result).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(await assistantRows()).toEqual([]);
    expect(await f.items()).toEqual([]);
  }),
);
