import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerTranscriptCommitter } from "../../gateway/worker-environments/transcript-commit.js";
import {
  createRequest,
  createTranscriptCommitIdentity,
} from "../../gateway/worker-environments/transcript-commit.test-support.js";
import {
  appendSessionTranscriptReport,
  readLatestSessionTranscriptReport,
} from "./session-accessor.sqlite-transcript-reports.js";
import type { SessionActorAuthority } from "./session-actor-contract.js";
import { createMemorySessionActorOwner } from "./session-actor-memory.js";
import { runWithSessionActorStorage } from "./session-actor-storage-binding.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import { SqliteTranscriptMutationConflictError } from "./session-mutation-conflict-error.js";
import { withPreparedTranscriptCorrection } from "./session-transcript-correction.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory reports opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory reports allocated a worker");
  }),
}));

const authority: SessionActorAuthority = { authorize() {}, assertCurrent() {} };
const scope = {
  agentId: "main",
  storePath: "/synthetic/reports",
  sessionKey: "agent:main:dashboard:incognito-reports",
  sessionId: "reports-1",
};
const owners: ReturnType<typeof createMemorySessionActorOwner>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.close();
  }
});

async function fixture() {
  const owner = createMemorySessionActorOwner({ agentId: scope.agentId, path: scope.storePath });
  owners.push(owner);
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey: scope.sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  const storage = actor.storage!;
  readSessionActorStorageResult(
    await storage.mutate(
      {
        type: "session.metadata.initialize",
        input: { scope, entry: { sessionId: scope.sessionId, updatedAt: 1, incognito: true } },
      },
      authority,
    ),
  );
  readSessionActorStorageResult(
    await storage.mutate(
      {
        type: "session.metadata.append",
        input: {
          scope,
          options: {},
          event: JSON.stringify({
            type: "session",
            version: 3,
            id: scope.sessionId,
            cwd: "/synthetic",
            timestamp: "2026-10-11T00:00:00.000Z",
          }),
        },
      },
      authority,
    ),
  );
  const binding = { actor, authority, agentId: scope.agentId, path: scope.storePath };
  const hydrate = async () => {
    const result = await storage.read({ type: "session.history.hydrate", input: {} }, authority);
    if (result.kind !== "full") {
      throw new Error("Expected complete memory transcript");
    }
    return result.snapshot;
  };
  const custom = async (id: string, content: string) =>
    readSessionActorStorageResult(
      await storage.mutate(
        {
          type: "session.metadata.append",
          input: {
            scope,
            options: { appendIntent: "active-branch" },
            event: JSON.stringify({
              type: "custom_message",
              id,
              parentId: null,
              customType: "status",
              content,
              display: true,
              timestamp: "2026-10-11T00:00:00.000Z",
            }),
          },
        },
        authority,
      ),
    );
  return { actor, storage, binding, hydrate, custom };
}

describe("memory transcript reports and edits", () => {
  it("reselects a custom report after an intervening in-process append and preserves prepared bytes", async () => {
    const { storage, binding, hydrate, custom } = await fixture();
    await custom("status-1", "first");
    let intervening: Promise<unknown> | undefined;
    let selections = 0;
    await runWithSessionActorStorage(binding, () =>
      appendSessionTranscriptReport(scope, {
        kind: "custom",
        customTypes: ["status"],
        selectReport(latest) {
          selections++;
          if (selections === 1) {
            intervening = custom("status-2", "second");
          }
          return {
            customType: "status",
            content: `after ${String(latest?.content)}`,
            display: true,
          };
        },
      }),
    );
    await intervening;
    expect(selections).toBe(2);
    expect(
      await runWithSessionActorStorage(binding, () =>
        readLatestSessionTranscriptReport(scope, ["status"]),
      ),
    ).toMatchObject({ ok: true, value: { content: "after second" } });
    const selected = await storage.read(
      {
        type: "session.report.prepare",
        input: { scope, selection: { kind: "custom", customTypes: ["status"] } },
      },
      authority,
    );
    if (!selected.ok) {
      throw new Error("Expected report selection");
    }
    const bytes = `{ "type":"custom_message", "id":"prepared-report", "parentId":${JSON.stringify(selected.value.facts.appendParentId)}, "timestamp":"2026-10-11T00:00:00.000Z", "customType":"status", "content":"exact", "display":true }`;
    readSessionActorStorageResult(
      await storage.mutate(
        {
          type: "session.report.append",
          input: {
            scope,
            version: selected.value.version,
            report: { kind: "custom", eventJson: bytes },
          },
        },
        authority,
      ),
    );
    expect((await hydrate()).eventJson?.at(-1)).toBe(bytes);
  });

  it("rejects a prepared correction after a concurrent edit without losing the appended row", async () => {
    const { binding, hydrate, custom } = await fixture();
    await custom("status-1", "first");
    const before = await hydrate();
    await expect(
      runWithSessionActorStorage(binding, () =>
        withPreparedTranscriptCorrection(scope, async (correction) => {
          const events = await correction.readEvents();
          await custom("status-2", "second");
          await correction.replaceEvents(
            events.map((event) =>
              typeof event === "object" &&
              event !== null &&
              "id" in event &&
              event.id === "status-1"
                ? Object.assign({}, event, { content: "overwritten" })
                : event,
            ),
          );
        }),
      ),
    ).rejects.toBeInstanceOf(SqliteTranscriptMutationConflictError);
    const after = await hydrate();
    expect(after.eventJson?.slice(0, before.eventJson?.length)).toEqual(before.eventJson);
    expect(after.events.at(-1)).toMatchObject({ id: "status-2", content: "second" });
  });

  it("commits and replays ordered worker batches without creating a durable ledger", async () => {
    const { binding, hydrate } = await fixture();
    const committer = createWorkerTranscriptCommitter({ getConfig: () => ({}) });
    const params = {
      identity: createTranscriptCommitIdentity(scope.sessionId, 7),
      sessionTarget: scope,
      request: createRequest({
        messages: [
          { role: "user", content: [{ type: "text", text: "one" }], timestamp: 1 },
          { role: "user", content: [{ type: "text", text: "two" }], timestamp: 2 },
        ],
      }),
      assertCurrent: () => undefined,
    };
    await runWithSessionActorStorage(binding, async () => {
      const first = await committer.commit(params);
      expect(first).toMatchObject({
        ok: true,
        result: {
          entryIds: [expect.any(String), expect.any(String)],
          newLeafId: expect.any(String),
        },
      });
      const before = await hydrate();
      expect(await committer.commit(params)).toEqual(first);
      expect(
        await committer.commit({
          ...params,
          request: {
            ...params.request,
            messages: [
              { role: "user", content: [{ type: "text", text: "changed" }], timestamp: 1 },
            ],
          },
        }),
      ).toEqual({ ok: false, reason: "invalid-batch" });
      expect(await committer.commit({ ...params, request: { ...params.request, seq: 3 } })).toEqual(
        { ok: false, reason: "invalid-batch" },
      );
      expect((await hydrate()).eventJson).toEqual(before.eventJson);
      const stale = await committer.commit({
        ...params,
        request: { ...params.request, seq: 2, baseLeafId: "other-branch" },
      });
      expect(stale).toEqual({ ok: false, reason: "stale-base-leaf" });
      expect(
        await committer.commit({
          ...params,
          request: { ...params.request, seq: 2, baseLeafId: "other-branch" },
        }),
      ).toEqual(stale);
      expect((await hydrate()).eventJson).toEqual(before.eventJson);
    });
  });
});
