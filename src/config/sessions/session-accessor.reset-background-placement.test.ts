import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, expect, it } from "vitest";
import { BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE } from "../../../packages/agent-core/src/harness/session/background-result-placement.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  appendTranscriptEvent,
  loadTranscriptEvents,
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.kernel.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { useTempSessionsFixture } from "./test-helpers.js";

const fixture = useTempSessionsFixture("openclaw-reset-background-placement-");
let storePath: string;

beforeEach(() => {
  storePath = fixture.storePath();
});

type Scope = { sessionId: string; sessionKey: string; storePath: string };

async function createScope(name: string): Promise<Scope> {
  const scope = { sessionId: `${name}-session`, sessionKey: `agent:main:${name}`, storePath };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
  return scope;
}

function appendMessage(
  scope: Scope,
  eventId: string,
  parentId: string | null,
  message: Record<string, unknown>,
) {
  const appended = appendTranscriptMessageSync(scope, { eventId, message, parentId });
  expect(appended.ok).toBe(true);
}

function appendReply(scope: Scope, eventId: string, parentId: string, text: string) {
  appendMessage(scope, eventId, parentId, {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: "anthropic",
    model: "claude-test",
    stopReason: "stop",
    timestamp: 2,
  });
}

/** A background job's result waits outside model context until the next request places it. */
async function appendPlacedBackgroundResult(scope: Scope, parentId: string, text: string) {
  appendMessage(scope, "result-1", parentId, {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: "openclaw",
    model: "automation-result",
    stopReason: "stop",
    excludeFromContext: true,
    openclawModelPlacement: "pending",
    timestamp: 3,
  });
  await expect(
    appendTranscriptEvent(scope, {
      type: "custom",
      id: "placement-1",
      parentId: "result-1",
      timestamp: new Date(4).toISOString(),
      customType: BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE,
      data: { afterEntryId: "result-1", resultEntryIds: ["result-1"] },
    }),
  ).resolves.toBe(true);
  appendMessage(scope, "user-2", "placement-1", {
    role: "user",
    content: "what did it say?",
    timestamp: 5,
  });
  appendReply(scope, "assistant-2", "user-2", "it finished");
}

async function resetSession(
  scope: Scope,
  resetBoundary: Parameters<typeof resetSessionEntryLifecycle>[0]["resetBoundary"],
) {
  await resetSessionEntryLifecycle({
    storePath,
    target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
    buildNextEntry: () => ({ sessionId: scope.sessionId, updatedAt: 20 }),
    resetBoundary,
  });
}

async function latestResetBoundary(scope: Scope) {
  const events = await loadTranscriptEvents(scope);
  return events.findLast((event) => isRecord(event) && event.type === "reset");
}

it.each(["idle", "daily"] as const)(
  "keeps the tail through a %s reset after a background result was placed",
  async (reason) => {
    const scope = await createScope(`placed-background-${reason}`);
    appendMessage(scope, "user-1", null, { role: "user", content: "start the job", timestamp: 1 });
    appendReply(scope, "assistant-1", "user-1", "started");
    await appendPlacedBackgroundResult(scope, "assistant-1", "job finished");

    // The automatic reset preserves the recent tail; an explicit /new clears instead.
    await resetSession(scope, { context: "preserve-tail", reason, cwd: "/tmp/workspace" });

    // The reset commits and keeps the recent conversation, so the next message gets a reply.
    expect(await latestResetBoundary(scope)).toMatchObject({
      reason,
      parentId: "assistant-2",
      firstKeptEntryId: "user-1",
    });
  },
);

it("keeps messages from before /new out of a later idle reset's tail", async () => {
  const scope = await createScope("placed-background-after-new");
  appendMessage(scope, "user-0", null, { role: "user", content: "before /new", timestamp: 0 });
  appendReply(scope, "assistant-0", "user-0", "answered before /new");
  await resetSession(scope, { context: "clear", reason: "new", cwd: "/tmp/workspace" });
  const cleared = await latestResetBoundary(scope);
  expect(cleared).toMatchObject({ reason: "new" });
  // Short enough that the recent-tail cap alone would reach back past /new.
  appendMessage(scope, "user-1", String((cleared as { id: string }).id), {
    role: "user",
    content: "start the job",
    timestamp: 1,
  });
  await appendPlacedBackgroundResult(scope, "user-1", "job finished");

  await resetSession(scope, { context: "preserve-tail", reason: "idle", cwd: "/tmp/workspace" });

  expect(await latestResetBoundary(scope)).toMatchObject({
    reason: "idle",
    parentId: "assistant-2",
    firstKeptEntryId: "user-1",
  });
});

it("plans the reset from compressed rows stored by 2026.11.10, which lack placement fields", async () => {
  const scope = await createScope("placed-background-stored-projection");
  appendMessage(scope, "user-1", null, { role: "user", content: "start the job", timestamp: 1 });
  appendReply(scope, "assistant-1", "user-1", "started");
  // A result over 1 KiB is stored compressed, with the reset projection recorded at write time.
  await appendPlacedBackgroundResult(scope, "assistant-1", "job finished\n".repeat(200));
  const { db } = openOpenClawAgentDatabase({
    agentId: "main",
    path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
  });
  // 2026.11.10 recorded only the message role in that projection.
  const rewritten = db
    .prepare(
      `UPDATE transcript_events
         SET navigation_json = json_set(navigation_json, '$.reset.message',
           json_object('role', json_extract(navigation_json, '$.reset.message.role')))
       WHERE session_id = ?
         AND json_extract(navigation_json, '$.reset.message.openclawModelPlacement') = 'pending'`,
    )
    .run(scope.sessionId);
  expect(rewritten.changes).toBe(1);

  await resetSession(scope, { context: "preserve-tail", reason: "idle", cwd: "/tmp/workspace" });

  expect(await latestResetBoundary(scope)).toMatchObject({
    reason: "idle",
    parentId: "assistant-2",
    firstKeptEntryId: "user-1",
  });
});
