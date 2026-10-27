import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sqliteRuntime from "../../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  forkSessionAtMessage,
  listSessionBranches,
  loadSessionEntry,
  replaceSessionEntry,
  rewindSessionToMessage,
  switchSessionBranch,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  branchMessage,
  branchSummary as summary,
  expectBranchList,
} from "./session-accessor.sqlite-branch-fixtures.test-support.js";
import {
  invalidateSessionBranchCache,
  type SessionBranchSummaryReadRequest,
} from "./session-accessor.sqlite-branches.js";
import { readSessionBranchSummariesInWorker } from "./session-accessor.sqlite-branches.worker.js";
import {
  agentId,
  sessionKey,
  useSessionMessageCutFixtures,
} from "./session-accessor.sqlite-message-cut.test-support.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import * as coldStorage from "./session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  historicalId,
  maintenanceConfig,
} from "./session-cold-storage.test-support.js";
import {
  waitForSessionTranscriptIndexReconcilesInStateDir,
  waitForSessionTranscriptProjection,
} from "./session-transcript-reconcile.js";
import { maintenanceLane, rotateDatabaseWorkers } from "./session-transcript-worker-resources.js";
import { messageEvent, timedMessageEvent } from "./transcript-message.test-support.js";

const { tempDirs, createSession, createSiblingSession } = useSessionMessageCutFixtures();
afterEach(() => vi.restoreAllMocks());

function expectActiveBranch(
  result: unknown,
  leafEntryId: string,
  headline: string,
  messageCount?: number,
) {
  expect(result).toMatchObject({
    status: "ok",
    branches: expect.arrayContaining([
      expect.objectContaining({
        active: true,
        leafEntryId,
        headline,
        ...(messageCount === undefined ? {} : { messageCount }),
      }),
    ]),
  });
}

function requireBranches(result: Awaited<ReturnType<typeof listSessionBranches>>) {
  assert(result.status === "ok", "expected branch list result");
  return result.branches;
}

describe("SQLite session branches", () => {
  it("retains a cold branch reader across concurrent viewers and transcript writes", async () => {
    const { env, scope } = await createSession();
    const sibling = await createSiblingSession({
      env,
      sessionId: "branch-reader-sibling",
      sessionKey: "agent:main:branch-reader-sibling",
      headline: "Sibling conversation",
    });
    await rotateDatabaseWorkers(maintenanceLane);
    const scopes = [scope, sibling];
    const before = await Promise.all(scopes.map(listSessionBranches));
    expect(before).toEqual([
      expect.objectContaining({ status: "ok" }),
      { status: "ok", branches: [expect.objectContaining({ headline: "Sibling conversation" })] },
    ]);

    await appendTranscriptMessage(sibling, {
      eventId: "branch-reader-answer",
      parentId: "branch-reader-sibling-user",
      message: { role: "assistant", content: "Updated sibling answer" },
    });
    const after = await Promise.all(scopes.map(listSessionBranches));
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual({
      status: "ok",
      branches: [
        expect.objectContaining({
          headline: "Updated sibling answer",
          leafEntryId: "branch-reader-answer",
          messageCount: 2,
        }),
      ],
    });
  });

  it("returns detached summaries to concurrent viewers", async () => {
    const { scope } = await createSession();
    const results = await Promise.all(Array.from({ length: 3 }, () => listSessionBranches(scope)));
    expect(results[0]).toMatchObject({ status: "ok" });
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    const second = results[1];
    assert(second?.status === "ok" && second.branches[0], "expected shared branch summaries");
    second.branches[0].headline = "caller mutation";
    expect(results[2]).toEqual(results[0]);
    await expect(listSessionBranches(scope)).resolves.toEqual(results[0]);
  });

  it("carries summaries between read snapshots without sharing caller-owned results", async () => {
    const { env, scope } = await createSession();
    const database = openOpenClawAgentDatabase({ agentId, env });
    const request: SessionBranchSummaryReadRequest = {
      database: { agentId, path: database.path },
      sessionKey,
    };
    await closeOpenClawAgentDatabaseByPathAsync(database.path, agentId);
    const first = readSessionBranchSummariesInWorker(request);
    expectActiveBranch(first, "assistant-2", "second answer", 4);
    assert(first.status === "ok" && first.branches[0]);
    request.previous = structuredClone(first);
    invalidateSessionBranchCache(database.path, [scope.sessionId]);
    expect(readSessionBranchSummariesInWorker(request)).toEqual(first);
    const original = structuredClone(first);
    first.branches[0].headline = "caller mutation";
    expect(readSessionBranchSummariesInWorker(request)).toEqual(original);
    let parentId = "assistant-2";
    for (const type of ["custom", "custom_message", "compaction", "reset"]) {
      const id = `metadata-${type}`;
      await appendTranscriptEvent(scope, { type, id, parentId });
      parentId = id;
    }
    await appendTranscriptMessage(scope, {
      eventId: "assistant-3",
      parentId,
      message: { role: "assistant", content: "third answer" },
    });
    expectActiveBranch(
      readSessionBranchSummariesInWorker(request),
      "assistant-3",
      "third answer",
      5,
    );
  });

  it("refuses cached worker summaries in cold storage and reuses them after restoration", async () => {
    const storePath = path.join(tempDirs.make("openclaw-branch-cold-"), "agent.sqlite");
    const fixture = await createSessionColdStorageFixture(storePath);
    await replaceSessionEntry(fixture.scope, { sessionId: historicalId, updatedAt: 1 });
    const request = {
      database: { agentId, path: storePath },
      sessionKey: fixture.scope.sessionKey,
    };
    const first = readSessionBranchSummariesInWorker(request);
    const branches = [summary("history-assistant", "Preserved response", 2, true)];
    expect(first).toMatchObject({ status: "ok", branches });
    await expect(
      coldStorage.runSessionColdStorageMaintenance({ config: maintenanceConfig(storePath) }),
    ).resolves.toMatchObject({ archivedTranscripts: 1 });
    expect(() => readSessionBranchSummariesInWorker(request)).toThrow(
      expect.objectContaining({ code: "TRANSCRIPT_COLD" }),
    );
    await expect(listSessionBranches(fixture.scope)).resolves.toMatchObject({
      status: "ok",
      branches,
    });
    expect(readSessionBranchSummariesInWorker(request)).toEqual(first);
  });

  it("recomputes summaries after physical database replacement with identical watermarks", async () => {
    const { env } = await createSession();
    const database = openOpenClawAgentDatabase({ agentId, env });
    const first = await listSessionBranches({ agentId, env, sessionKey });
    expect(first.status).toBe("ok");

    // Canonical close drains readers and checkpoints WAL before copying the complete database.
    await closeOpenClawAgentDatabaseByPathAsync(database.path, agentId);
    const replacement = `${database.path}.replacement`;
    fs.copyFileSync(database.path, replacement);
    {
      using peer = sqliteRuntime.openNodeSqliteDatabase(replacement);
      peer
        .prepare(`UPDATE transcript_events
        SET event_json = json_set(event_json, '$.message.content', 'replacement headline')
        WHERE session_id = ? AND seq = (
          SELECT seq FROM transcript_event_identities
          WHERE session_id = ? AND event_id = 'assistant-2'
        )`)
        .run("message-cut-source", "message-cut-source");
    }
    fs.renameSync(replacement, database.path);

    for (let read = 0; read < 2; read++) {
      expectActiveBranch(
        await listSessionBranches({ agentId, env, sessionKey }),
        "assistant-2",
        "replacement headline",
        4,
      );
    }
    expect(isOpenClawAgentDatabaseOpen(database.path)).toBe(false);
  });

  it("refreshes appended and replaced sessions", async () => {
    const { env, scope } = await createSession();
    const replacement = await createSiblingSession({
      env,
      sessionId: "replacement-source",
      sessionKey: "agent:main:replacement-source",
      headline: "replacement conversation",
    });
    await waitForSessionTranscriptIndexReconcilesInStateDir(env.OPENCLAW_STATE_DIR);

    const before = await listSessionBranches({ agentId, env, sessionKey });
    await appendTranscriptMessage(scope, {
      eventId: "assistant-3",
      message: { role: "assistant", content: "third answer" },
      now: Date.parse("2026-07-18T00:00:07.000Z"),
      parentId: "assistant-2",
    });

    await waitForSessionTranscriptIndexReconcilesInStateDir(env.OPENCLAW_STATE_DIR);
    const after = await listSessionBranches({ agentId, env, sessionKey });
    expect(after).not.toEqual(before);
    expect(requireBranches(after).find((branch) => branch.active)).toMatchObject({
      leafEntryId: "assistant-3",
      headline: "third answer",
    });

    await replaceSessionEntry(scope, { sessionId: replacement.sessionId, updatedAt: 2 });
    await expect(listSessionBranches({ agentId, env, sessionKey })).resolves.toMatchObject({
      status: "ok",
      branches: [{ headline: "replacement conversation", leafEntryId: "replacement-source-user" }],
    });
  });

  it.each(["rewind", "switch", "fork"] as const)(
    "%s invalidates the source cache and lists the resulting branch",
    async (mode) => {
      const { env, scope } = await createSession();
      const aliasKey = `${sessionKey}:alias`;
      const targetKey = `${sessionKey}:fork`;
      const sourceEntry = loadSessionEntry(scope);
      if (!sourceEntry) {
        throw new Error("expected source session entry");
      }
      await upsertSessionEntryCore({ agentId, env, sessionKey: aliasKey }, sourceEntry);
      await listSessionBranches({ agentId, env, sessionKey });

      const source = { agentId, env, sessionKey };
      const result =
        mode === "rewind"
          ? await rewindSessionToMessage({ ...source, entryId: "user-2" })
          : mode === "switch"
            ? await switchSessionBranch({ ...source, leafEntryId: "off-path-user" })
            : await forkSessionAtMessage({ ...source, entryId: "user-2", targetKey });
      expect(result.status).toBe("created");

      await expect(
        listSessionBranches({ agentId, env, sessionKey: aliasKey }),
      ).resolves.toMatchObject({ status: "ok" });

      const listed = await listSessionBranches({
        agentId,
        env,
        sessionKey: mode === "fork" ? targetKey : sessionKey,
      });
      expect(requireBranches(listed).find((branch) => branch.active)).toMatchObject({
        leafEntryId: mode === "switch" ? "off-path-user" : "assistant-1",
      });
    },
  );

  it("refreshes phased Unicode headlines across opaque payloads and rewrites", async () => {
    const { scope } = await createSession();
    const opaque = "x".repeat(256 * 1024);
    const finalText = "🦞".repeat(130);
    const events = [
      { type: "session", id: scope.sessionId, version: 3 },
      branchMessage("prompt", null, "prompt"),
      messageEvent("answer", "prompt", {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "commentary",
            textSignature: JSON.stringify({ v: 1, phase: "commentary" }),
          },
          { type: "text", text: "legacy text" },
          {
            type: "output_text",
            text: finalText,
            textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
          },
        ],
        providerReplay: { opaque },
      }),
      ...Array.from({ length: 8 }, (_, index) =>
        messageEvent(`tool-${index}`, index === 0 ? "answer" : `tool-${index - 1}`, {
          role: "toolResult",
          toolCallId: `call-${index}`,
          content: opaque,
          details: { opaque },
        }),
      ),
    ];
    await replaceTranscriptEvents(scope, events);
    await waitForSessionTranscriptProjection(scope);

    await expectBranchList(scope, [summary("tool-7", `${"🦞".repeat(119)}…`, 10, true)]);

    await replaceTranscriptEvents(
      scope,
      events.map((event) =>
        event.id === "answer"
          ? Object.assign({}, event, {
              message: { role: "assistant", content: "new final answer" },
            })
          : event,
      ),
    );
    await waitForSessionTranscriptProjection(scope);
    await expect(listSessionBranches(scope)).resolves.toMatchObject({
      status: "ok",
      branches: [{ active: true, headline: "new final answer", messageCount: 10 }],
    });
  });

  it("lists current memory branches after writes and leaves missing sessions absent", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-memory-branches-") };
    const scope = {
      agentId,
      env,
      sessionId: "memory-branch-source",
      sessionKey: "agent:main:dashboard:incognito-branches",
      storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId, env }),
    };
    const owner = memorySessionActorOwners.get({ agentId, path: scope.storePath });
    const actor = await owner.acquire(
      { database: owner.identity, sessionKey: scope.sessionKey },
      { assertCurrent() {}, assertReadable() {} },
    );
    try {
      expect(
        await actor.storage!.mutate(
          {
            type: "session.entry.create",
            input: {
              entry: { sessionId: scope.sessionId, updatedAt: 1, incognito: true },
              transcriptEvents: [
                branchMessage("user-2", null, "second prompt"),
                branchMessage("assistant-2", "user-2", "second answer", { role: "assistant" }),
              ],
            },
          },
          { assertCurrent() {}, authorize() {} },
        ),
      ).toMatchObject({ kind: "committed" });
    } finally {
      await actor.release();
    }
    const sqlite = vi.spyOn(sqliteRuntime, "requireNodeSqlite").mockImplementation(() => {
      throw new Error("Memory branch listing opened SQLite");
    });
    try {
      expectActiveBranch(await listSessionBranches(scope), "assistant-2", "second answer");
      await appendTranscriptMessage(scope, {
        eventId: "assistant-3",
        parentId: "assistant-2",
        now: Date.parse("2026-07-18T00:00:07.000Z"),
        message: { role: "assistant", content: "fresh memory answer" },
      });
      expectActiveBranch(await listSessionBranches(scope), "assistant-3", "fresh memory answer");
      await expect(
        listSessionBranches({
          ...scope,
          sessionKey: "agent:main:dashboard:incognito-missing",
        }),
      ).resolves.toEqual({ status: "missing-session" });
      memorySessionActorOwners.closeDatabase(owner);
      await expect(listSessionBranches(scope)).resolves.toEqual({ status: "missing-session" });
      expect(sqlite).not.toHaveBeenCalled();
    } finally {
      sqlite.mockRestore();
      memorySessionActorOwners.closeDatabase(owner);
    }
  });

  it("summarizes a large shared branch graph without repeated path walks", async () => {
    const stateDir = tempDirs.make("openclaw-large-branches-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const sessionId = "large-branches-source";
    const scope = { agentId, env, sessionId, sessionKey };
    await upsertSessionEntryCore(scope, { sessionId, updatedAt: Date.now() });
    // Match replacement's resident writer so warmup and measurement use the maintenance reader.
    // Replacement below still forces a fresh graph scan.
    openOpenClawAgentDatabase({ agentId, env });
    await expectBranchList(scope, []);
    const events: Parameters<typeof replaceTranscriptEvents>[1] = [
      {
        type: "session",
        id: sessionId,
        version: 3,
        timestamp: "2026-08-30T00:00:00.000Z",
      },
      branchMessage("orphan-user", "missing-ancestor", "orphan prompt", {
        timestamp: "2026-08-30T00:00:01.000Z",
      }),
      branchMessage("orphan-assistant", "orphan-user", "orphan answer", {
        role: "assistant",
        timestamp: "2026-08-30T00:00:02.000Z",
      }),
    ];
    for (let index = 1; index <= 12_554; index += 1) {
      events.push(
        timedMessageEvent(
          `main-${index}`,
          index === 1 ? null : `main-${index - 1}`,
          new Date(Date.UTC(2026, 7, 30, 0, 0, index)).toISOString(),
          { role: index % 2 === 0 ? "assistant" : "user", content: `main ${index}` },
        ),
      );
    }
    for (let index = 1; index <= 1_360; index += 1) {
      events.push({
        type: "message",
        id: `side-${index}`,
        parentId: "main-5376",
        appendMode: "side",
        timestamp: new Date(Date.UTC(2026, 7, 30, 1, 0, index)).toISOString(),
        message: { role: "assistant", content: `side ${index}` },
      });
    }
    events.push({
      type: "leaf",
      id: "active-leaf",
      parentId: "main-12554",
      targetId: "main-12554",
      timestamp: "2026-08-30T02:00:02.000Z",
    });
    await replaceTranscriptEvents(scope, events);

    const startedAt = performance.now();
    const result = await listSessionBranches({ agentId, env, sessionKey });
    const elapsedMs = performance.now() - startedAt;
    const listed = requireBranches(result);
    expect(elapsedMs).toBeLessThan(1_000);
    expect(listed).toHaveLength(1_362);
    expect(listed.find((branch) => branch.leafEntryId === "orphan-assistant")).toEqual(
      summary("orphan-assistant", "orphan answer", 2, false, "2026-08-30T00:00:02.000Z"),
    );
  }, 15_000);
});
