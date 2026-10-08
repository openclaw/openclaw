import path from "node:path";
import {
  readSessionTranscriptVisibleMessageDelta,
  SessionTranscriptReadFenceError,
  type SessionTranscriptVisibleMessageDeltaParams,
  type SessionTranscriptVisibleMessageDeltaResult,
} from "openclaw/plugin-sdk/context-engine-transcript-runtime";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { runWithSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { appendSessionTranscriptMessageByIdentity } from "./session-transcript-runtime.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-sdk-context-engine-transcript-");

type Scope = { agentId: string; sessionId: string; sessionKey: string; storePath: string };

function page(result: SessionTranscriptVisibleMessageDeltaResult) {
  if (result.kind !== "page") {
    throw new Error(`expected a transcript page, got ${result.kind}`);
  }
  return result;
}

// Drains every page the way a context engine would, returning entry ids and the final cursor.
async function drain(params: SessionTranscriptVisibleMessageDeltaParams) {
  const ids: string[] = [];
  let cursor = params.cursor;
  for (;;) {
    const next = page(await readSessionTranscriptVisibleMessageDelta({ ...params, cursor }));
    ids.push(...next.entries.map((entry) => entry.entryId));
    cursor = next.cursor;
    if (!next.hasMore) {
      return { cursor, ids };
    }
  }
}

// Appends to the current leaf so resets and later messages stay on one active path.
async function append(scope: Scope, eventId: string, message: object) {
  const result = await appendSessionTranscriptMessageByIdentity({ ...scope, eventId, message });
  if (!result) {
    throw new Error(`expected ${eventId} to append`);
  }
  return result;
}

async function resetSession(scope: Scope, context: "clear" | "preserve-tail") {
  await resetSessionEntryLifecycle({
    agentId: scope.agentId,
    storePath: scope.storePath,
    target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
    resetBoundary:
      context === "clear"
        ? { context, reason: "reset", cwd: path.dirname(scope.storePath) }
        : { context, reason: "idle", cwd: path.dirname(scope.storePath) },
    buildNextEntry: ({ currentEntry }) => {
      if (!currentEntry) {
        throw new Error("expected the current session entry");
      }
      return { ...currentEntry, updatedAt: currentEntry.updatedAt + 1 };
    },
  });
}

describe("context-engine transcript SDK", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = sessionDirs.make();
  });

  async function createScope(sessionId: string): Promise<Scope> {
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath: path.join(tempDir, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
    return scope;
  }

  it("starts reset-window drains at the retained tail, with paired tool results", async () => {
    const scope = await createScope("preserve-tail");
    for (const [id, message] of [
      ["old-0", { role: "user", content: "q0" }],
      ["old-1", { role: "assistant", content: "a1" }],
      ["old-2", { role: "user", content: "q2" }],
      ["old-3", { role: "assistant", content: "a3" }],
      ["old-4", { role: "user", content: "q4" }],
      [
        "old-5",
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
          stopReason: "toolUse",
        },
      ],
      [
        "old-6",
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "paired" }],
          isError: false,
        },
      ],
      [
        "old-7",
        {
          role: "toolResult",
          toolCallId: "orphan-call",
          toolName: "read",
          content: [{ type: "text", text: "orphan" }],
          isError: false,
        },
      ],
      ["old-8", { role: "assistant", content: "a8" }],
      ["old-9", { role: "user", content: "q9" }],
      ["old-10", { role: "assistant", content: "a10" }],
    ] as const) {
      await append(scope, id, message);
    }
    await resetSession(scope, "preserve-tail");
    const admitted = await append(scope, "new-user", { role: "user", content: "new" });

    // The default start is unchanged: a fresh drain still includes pre-reset history.
    await expect(drain({ ...scope, maxMessages: 4 })).resolves.toMatchObject({
      ids: [
        "old-0",
        "old-1",
        "old-2",
        "old-3",
        "old-4",
        "old-5",
        "old-6",
        "old-7",
        "old-8",
        "old-9",
        "old-10",
        "new-user",
      ],
    });
    // Reset-window pages walk the retained tail (without the orphan result), then the suffix.
    const windowed = await drain({ ...scope, maxMessages: 4, start: "reset-window" });
    expect(windowed.ids).toEqual([
      "old-4",
      "old-5",
      "old-6",
      "old-8",
      "old-9",
      "old-10",
      "new-user",
    ]);

    await append(scope, "after", { role: "assistant", content: "after" });
    await expect(
      drain({ ...scope, cursor: windowed.cursor, start: "reset-window" }),
    ).resolves.toMatchObject({ ids: ["after"] });

    // Inside the current-turn fence, the drain stops before the admitted user entry.
    if (!admitted.anchor) {
      throw new Error("expected an admitted transcript anchor");
    }
    const fence = { ...admitted.anchor, logicalTurnId: "fenced-turn", role: "user" as const };
    await expect(
      runWithSessionTranscriptReadFence(fence, () => drain({ ...scope, start: "reset-window" })),
    ).resolves.toMatchObject({ ids: ["old-4", "old-5", "old-6", "old-8", "old-9", "old-10"] });
    await expect(
      runWithSessionTranscriptReadFence(fence, () =>
        readSessionTranscriptVisibleMessageDelta({ ...scope, cursor: windowed.cursor }),
      ),
    ).rejects.toBeInstanceOf(SessionTranscriptReadFenceError);
  });

  it("invalidates reset-window cursors at a later reset while default cursors keep appending", async () => {
    const scope = await createScope("clear");
    await append(scope, "before-user", { role: "user", content: "before" });
    await append(scope, "before-assistant", {
      role: "assistant",
      content: "before reply",
    });

    // Without a reset, reset-window and default drains return the same history.
    const windowed = await drain({ ...scope, start: "reset-window" });
    const transcript = await drain({ ...scope });
    expect(windowed.ids).toEqual(["before-user", "before-assistant"]);
    expect(transcript.ids).toEqual(windowed.ids);

    await resetSession(scope, "clear");
    await append(scope, "after-user", { role: "user", content: "after" });

    await expect(drain({ ...scope, cursor: transcript.cursor })).resolves.toMatchObject({
      ids: ["after-user"],
    });
    const reset = await readSessionTranscriptVisibleMessageDelta({
      ...scope,
      cursor: windowed.cursor,
    });
    expect(reset).toMatchObject({ kind: "reset", reason: "session_reset" });
    if (reset.kind !== "reset") {
      throw new Error("expected a session reset");
    }
    // The fresh cursor stays in reset-window mode even when the caller omits start.
    await expect(drain({ ...scope, cursor: reset.cursor })).resolves.toMatchObject({
      ids: ["after-user"],
    });
    await expect(drain({ ...scope, start: "reset-window" })).resolves.toMatchObject({
      ids: ["after-user"],
    });
  });
});
