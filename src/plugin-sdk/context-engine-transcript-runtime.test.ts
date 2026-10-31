import path from "node:path";
import * as transcript from "openclaw/plugin-sdk/context-engine-transcript-runtime";
import { afterAll, assert, expect, it } from "vitest";
import * as sessions from "../config/sessions/session-accessor.js";
import { runWithSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { appendSessionTranscriptMessageByIdentity } from "./session-transcript-runtime.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-sdk-context-engine-transcript-");

type Scope = { agentId: string; sessionId: string; sessionKey: string; storePath: string };

async function drain(params: transcript.SessionTranscriptVisibleMessageDeltaParams) {
  const ids: string[] = [];
  let cursor = params.cursor;
  for (;;) {
    const next = await transcript.readSessionTranscriptVisibleMessageDelta({ ...params, cursor });
    assert(next.kind === "page", `expected a transcript page, got ${next.kind}`);
    ids.push(...next.entries.map((entry) => entry.entryId));
    cursor = next.cursor;
    if (!next.hasMore) {
      return { cursor, ids };
    }
  }
}

const expectIds = (params: transcript.SessionTranscriptVisibleMessageDeltaParams, ids: string[]) =>
  expect(drain(params)).resolves.toMatchObject({ ids });

async function expectReset(
  params: transcript.SessionTranscriptVisibleMessageDeltaParams,
  reason = "session_reset",
) {
  const result = await transcript.readSessionTranscriptVisibleMessageDelta(params);
  expect(result).toMatchObject({ kind: "reset", reason });
  assert(result.kind === "reset", "expected a session reset");
  return result.cursor;
}

async function append(scope: Scope, eventId: string, message: object) {
  const result = await appendSessionTranscriptMessageByIdentity({ ...scope, eventId, message });
  assert(result, `expected ${eventId} to append`);
  return result;
}

async function resetSession(scope: Scope, context: "clear" | "preserve-tail") {
  await sessions.resetSessionEntryLifecycle({
    agentId: scope.agentId,
    storePath: scope.storePath,
    target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
    resetBoundary:
      context === "clear"
        ? { context, reason: "reset", cwd: path.dirname(scope.storePath) }
        : { context, reason: "idle", cwd: path.dirname(scope.storePath) },
    buildNextEntry: ({ currentEntry }) => {
      assert(currentEntry, "expected the current session entry");
      return { ...currentEntry, updatedAt: currentEntry.updatedAt + 1 };
    },
  });
}

function toolResult(toolCallId: string, text: string) {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
  };
}

async function createScope(sessionId: string): Promise<Scope> {
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(sessionDirs.make(), "sessions.json"),
  };
  await sessions.upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
  return scope;
}

it("starts reset-window drains at the retained tail, with paired tool results", async () => {
  const scope = await createScope("preserve-tail");
  const messages = [
    { role: "user", content: "q0" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "q2" },
    { role: "assistant", content: "a3" },
    { role: "user", content: "q4" },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
      stopReason: "toolUse",
    },
    toolResult("call-1", "paired"),
    toolResult("orphan-call", "orphan"),
    { role: "assistant", content: "a8" },
    { role: "user", content: "q9" },
    { role: "assistant", content: "a10" },
  ];
  for (const [index, message] of messages.entries()) {
    await append(scope, `old-${index}`, message);
  }
  await resetSession(scope, "preserve-tail");
  const admitted = await append(scope, "new-user", { role: "user", content: "new" });
  await expectIds({ ...scope, maxMessages: 4 }, [
    ...Array.from({ length: 11 }, (_, i) => `old-${i}`),
    "new-user",
  ]);
  const windowed = await drain({ ...scope, maxMessages: 4, start: "reset-window" });
  const retained = ["old-4", "old-5", "old-6", "old-8", "old-9", "old-10"];
  expect(windowed.ids).toEqual([...retained, "new-user"]);
  await append(scope, "after", { role: "assistant", content: "after" });
  await expectIds({ ...scope, cursor: windowed.cursor, start: "reset-window" }, ["after"]);
  assert(admitted.anchor, "expected an admitted transcript anchor");
  const fence = { ...admitted.anchor, logicalTurnId: "fenced-turn", role: "user" as const };
  await expect(
    runWithSessionTranscriptReadFence(fence, () => drain({ ...scope, start: "reset-window" })),
  ).resolves.toMatchObject({ ids: retained });
  await expect(
    runWithSessionTranscriptReadFence(fence, () =>
      transcript.readSessionTranscriptVisibleMessageDelta({ ...scope, cursor: windowed.cursor }),
    ),
  ).rejects.toBeInstanceOf(transcript.SessionTranscriptReadFenceError);
});

it("invalidates reset-window cursors at a later reset while default cursors keep appending", async () => {
  const scope = await createScope("clear");
  await append(scope, "before-user", { role: "user", content: "before" });
  await append(scope, "before-assistant", {
    role: "assistant",
    content: "before reply",
  });
  const windowed = await drain({ ...scope, start: "reset-window" });
  const full = await drain({ ...scope });
  expect(windowed.ids).toEqual(["before-user", "before-assistant"]);
  expect(full.ids).toEqual(windowed.ids);
  await resetSession(scope, "clear");
  await append(scope, "after-user", { role: "user", content: "after" });
  await expectIds({ ...scope, cursor: full.cursor }, ["after-user"]);
  const cursor = await expectReset({ ...scope, cursor: windowed.cursor });
  await expectIds({ ...scope, cursor }, ["after-user"]);
  await expectIds({ ...scope, start: "reset-window" }, ["after-user"]);
});

it("ranks a reset above a generation rotation for reset-window cursors", async () => {
  const scope = await createScope("rotated");
  await append(scope, "old-user", { role: "user", content: "old" });
  await resetSession(scope, "clear");
  const edited = await append(scope, "edited-user", { role: "user", content: "draft" });
  assert(edited.anchor, "expected an edited transcript anchor");
  const anchor = edited.anchor;
  const editInPlace = (content: string) =>
    sessions.rewriteTranscriptMessageAtAnchor(anchor, (message) => ({
      ...(message as object),
      content,
    }));
  const first = await drain({ ...scope, start: "reset-window" });
  expect(first.ids).toEqual(["edited-user"]);
  await editInPlace("edited");
  await expectReset({ ...scope, cursor: first.cursor }, "generation_mismatch");
  const second = await drain({ ...scope, start: "reset-window" });
  expect(second.ids).toEqual(["edited-user"]);
  await editInPlace("edited again");
  await resetSession(scope, "clear");
  await append(scope, "new-user", { role: "user", content: "new" });
  const cursor = await expectReset({ ...scope, cursor: second.cursor });
  await expectIds({ ...scope, cursor }, ["new-user"]);
});
