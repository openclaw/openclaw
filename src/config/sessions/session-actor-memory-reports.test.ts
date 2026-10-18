import "./session-actor-memory-native-guards.test-support.js";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it } from "vitest";
import { createWorkerTranscriptCommitter } from "../../gateway/worker-environments/transcript-commit.js";
import {
  createRequest,
  createTranscriptCommitIdentity,
} from "../../gateway/worker-environments/transcript-commit.test-support.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  appendSessionTranscriptReport,
  readLatestSessionTranscriptReport,
} from "./session-accessor.sqlite-transcript-reports.js";
import {
  authority,
  header,
  memoryFixture,
  messageEvent,
  timestamp,
  expectMatch,
  expectEqual,
} from "./session-actor-memory-fixture.test-support.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { mutateMemory } from "./session-actor-memory-publication.test-support.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import { rewritePreparedTranscriptMessageAtAnchor } from "./session-message-rewrite.js";
import { SqliteTranscriptMutationConflictError } from "./session-mutation-conflict-error.js";
import { withPreparedTranscriptCorrection } from "./session-transcript-correction.js";
import { SessionTranscriptWriterClaimReboundError } from "./session-transcript-writer-claim-error.js";

const env = { OPENCLAW_STATE_DIR: "/synthetic/reports" };
const scope = {
  env,
  agentId: "main",
  storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  sessionKey: "agent:main:dashboard:incognito-reports",
  sessionId: "reports-1",
};
const selection = { kind: "custom" as const, customTypes: ["status"] };
const status = (content: string) => ({ customType: "status", content, display: true });

function workerBatch(request = createRequest(), assertCurrent = () => undefined) {
  const identity = createTranscriptCommitIdentity(scope.sessionId, 7);
  return { identity, sessionTarget: scope, request, assertCurrent };
}

async function fixture() {
  const f = await memoryFixture(scope, true);
  await f.initialize({ sessionId: scope.sessionId, updatedAt: 1, incognito: true });
  await f.appendRaw(JSON.stringify(header(scope.sessionId)));
  const custom = (id: string, content: string) =>
    f.appendRaw(
      JSON.stringify({ type: "custom_message", id, parentId: null, ...status(content), timestamp }),
      { appendIntent: "active-branch" },
    );
  return { ...f, custom };
}

it("reselects a mixed-case session report after an intervening append and preserves prepared bytes", async () => {
  const { read, commit, hydrate, custom } = await fixture();
  const reportScope = { ...scope, sessionKey: "agent:main:dashboard:incognito-RePoRtS" };
  await custom("status-1", "first");
  let intervening: Promise<unknown> | undefined;
  let selections = 0;
  await appendSessionTranscriptReport(reportScope, {
    ...selection,
    selectReport(latest) {
      selections++;
      if (selections === 1) {
        intervening = custom("status-2", "second");
      }
      return status(`after ${String(latest?.content)}`);
    },
  });
  await intervening;
  expect(selections).toBe(2);
  await expectMatch(readLatestSessionTranscriptReport(reportScope, ["status"]), {
    ok: true,
    value: { content: "after second" },
  });
  const selected = await read("session.report.prepare", {
    scope: reportScope,
    selection,
  });
  assert(selected.ok, "Expected report selection");
  const bytes = `{ "type":"custom_message", "id":"prepared-report", "parentId":${JSON.stringify(selected.value.facts.appendParentId)}, "timestamp":"2026-10-11T00:00:00.000Z", "customType":"status", "content":"exact", "display":true }`;
  await commit("session.report.append", {
    scope: reportScope,
    version: selected.value.version,
    report: { kind: "custom", eventJson: bytes },
  });
  expect((await hydrate()).eventJson?.at(-1)).toBe(bytes);
});

it("refuses durable file authority and does not recreate a missing memory session", async () => {
  const { hydrate } = await fixture();
  const before = await hydrate();
  const report = { ...selection, selectReport: () => status("private") };
  await expect(
    appendSessionTranscriptReport(scope, report, {
      sessionEntryCurrent: {
        source: {
          agentId: scope.agentId,
          path: "/synthetic/foreign.sqlite",
          databaseIdentity: "foreign",
          sessionKey: scope.sessionKey,
        },
        assertCurrent() {},
      },
    }),
  ).rejects.toThrow("A file session source cannot authorize a memory transcript report");
  expect((await hydrate()).eventJson).toEqual(before.eventJson);
  memorySessionActorOwners.closeDatabase({ agentId: scope.agentId, path: scope.storePath });
  await expect(appendSessionTranscriptReport(scope, report)).resolves.toMatchObject({
    ok: false,
    error: { code: "session-entry-missing" },
  });
  expect(
    memorySessionActorOwners.read({ agentId: scope.agentId, path: scope.storePath }),
  ).toBeUndefined();
});

it("preserves admission for identical replay text but revokes it for projection or content edits", async () => {
  const { appendMessage, hydrate } = await fixture();
  const user = messageEvent("user-1", null, { role: "user", content: "question", timestamp: 1 });
  await appendMessage(user);
  const projection = (text: string) => ({
    ...user.message,
    __openclaw: {
      steerTargetRunId: "running-turn",
      modelPromptProjection: { version: 1, text },
    },
  });
  for (const [index, message] of [
    projection("question"),
    projection("changed"),
    { ...projection("changed"), content: "edited" },
  ].entries()) {
    const before = await hydrate();
    const replacement = { ...user, message };
    await withPreparedTranscriptCorrection(scope, async (correction) => {
      const events = await correction.readEvents();
      await correction.replaceEvents([...events.slice(0, -1), replacement]);
    });
    const after = await hydrate();
    expect(after.eventJson?.at(-1)).toBe(JSON.stringify(replacement));
    expect(after.version.generation === before.version.generation).toBe(index === 0);
  }
});

it("rejects a prepared correction after a concurrent edit without losing the appended row", async () => {
  const { hydrate, custom } = await fixture();
  await custom("status-1", "first");
  const before = await hydrate();
  await expect(
    withPreparedTranscriptCorrection(scope, async (correction) => {
      const events = await correction.readEvents();
      await custom("status-2", "second");
      await correction.replaceEvents(
        events.map((event) =>
          isRecord(event) && event.id === "status-1"
            ? Object.assign({}, event, { content: "overwritten" })
            : event,
        ),
      );
    }),
  ).rejects.toBeInstanceOf(SqliteTranscriptMutationConflictError);
  const after = await hydrate();
  expect(after.eventJson?.slice(0, before.eventJson?.length)).toEqual(before.eventJson);
  expect(after.events.at(-1)).toMatchObject({ id: "status-2", content: "second" });
});

it("rewrites an unbound anchored message while preserving later appends and rejecting competing edits", async () => {
  const { actor, storage, commit, hydrate } = await fixture();
  for (const content of ["first", "later"]) {
    await commit("session.transcript.appendMessage", {
      scope,
      messageJson: JSON.stringify({ role: "user", content, timestamp: 1 }),
      cwd: "/synthetic",
    });
  }
  const anchor = actor.snapshot(authority)!.transcript.anchors[0]!;
  await expect(
    rewritePreparedTranscriptMessageAtAnchor(anchor, (message) =>
      Object.assign({}, message, { content: "revised" }),
    ),
  ).resolves.toMatchObject({ message: { content: "revised" } });
  const before = await hydrate();
  const currentAnchor = actor.snapshot(authority)!.transcript.anchors[0]!;
  const index = before.events.findIndex(
    (event) => isRecord(event) && event.id === currentAnchor.entryId,
  );
  let competing: ReturnType<typeof storage.mutate> | undefined;
  await expect(
    rewritePreparedTranscriptMessageAtAnchor(currentAnchor, (message) => {
      competing = mutateMemory(storage, "session.correction.commit", {
        scope,
        version: before.version,
        allowLaterAppends: true,
        rows: [
          {
            entryId: currentAnchor.entryId,
            expectedEventJson: before.eventJson![index]!,
            event: Object.assign({}, before.events[index], {
              message: Object.assign({}, message, { content: "competing" }),
            }),
          },
        ],
      });
      return Object.assign({}, message, { content: "lost update" });
    }),
  ).rejects.toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
  readSessionActorStorageResult(await competing!);
  expect((await hydrate()).events).toMatchObject([
    { type: "session" },
    { type: "message", message: { content: "competing" } },
    { type: "message", message: { content: "later" } },
  ]);
});

it("refuses a worker batch when placement authority closes during acquisition", async () => {
  const { hydrate } = await fixture();
  const before = await hydrate();
  const committer = createWorkerTranscriptCommitter({ getConfig: () => ({}) });
  let current = true;
  const commit = committer.commit(
    workerBatch(createRequest(), () => {
      if (!current) {
        throw new Error("Placement owner ended");
      }
    }),
  );
  current = false;
  await expect(commit).rejects.toThrow("Placement owner ended");
  expect((await hydrate()).eventJson).toEqual(before.eventJson);
});

it("commits and replays ordered worker batches without creating a durable ledger", async () => {
  const { hydrate } = await fixture();
  const committer = createWorkerTranscriptCommitter({ getConfig: () => ({}) });
  const batchRequest = createRequest({
    messages: [
      { role: "user", content: [{ type: "text", text: "one" }], timestamp: 1 },
      { role: "user", content: [{ type: "text", text: "two" }], timestamp: 2 },
    ],
  });
  const params = workerBatch(batchRequest);
  const first = await committer.commit(params);
  expect(first).toMatchObject({
    ok: true,
    result: { entryIds: [expect.any(String), expect.any(String)], newLeafId: expect.any(String) },
  });
  const before = await hydrate();
  await expectEqual(committer.commit(params), first);
  const invalid = { ok: false, reason: "invalid-batch" };
  for (const request of [
    {
      ...params.request,
      messages: [{ role: "user", content: [{ type: "text", text: "changed" }], timestamp: 1 }],
    },
    { ...params.request, seq: 3 },
  ] satisfies Array<typeof params.request>) {
    await expectEqual(committer.commit({ ...params, request }), invalid);
  }
  expect((await hydrate()).eventJson).toEqual(before.eventJson);
  const staleParams = {
    ...params,
    request: { ...params.request, seq: 2, baseLeafId: "other-branch" },
  };
  const stale = await committer.commit(staleParams);
  expect(stale).toEqual({ ok: false, reason: "stale-base-leaf" });
  await expectEqual(committer.commit(staleParams), stale);
  expect((await hydrate()).eventJson).toEqual(before.eventJson);
});
