import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred, awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveDefaultSessionStorePath } from "../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
  listSessionTranscriptInstances,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import * as historyReaders from "../config/sessions/session-transcript-worker-readers.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  loadArchivedSessions,
  loadArchivedSessionsAsync,
  loadMemorySessionMetadataAsync,
  loadMemorySessionMetadataBatchAsync,
  resolveMemorySessionTargets,
  resolveMemorySessionTargetsAsync,
} from "./memory-core-host-engine-sessions.js";

type SessionScope = { agentId: string; storePath?: string };
const sessionEntry = (sessionId: string, hookExternalContentSource: string, updatedAt = 1_000) => ({
  sessionId,
  hookExternalContentSource,
  updatedAt,
});
async function closeDatabases() {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
}
async function withoutHostSql(run: () => Promise<void>) {
  const sql = observeHostDataSql();
  try {
    await run();
    expect(sql.queries).toEqual([]);
    for (const call of sql.calls) {
      expect(call).not.toHaveBeenCalled();
    }
  } finally {
    sql.restore();
  }
}
const withSessionState = (run: Parameters<typeof withOpenClawTestState>[1]) =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({});
    await run(state);
  });
const appendUserMessage = (scope: Parameters<typeof appendTranscriptMessage>[0], content: string) =>
  appendTranscriptMessage(scope, { message: { role: "user", content } });
const archive = (scope: SessionScope, sessionKey: string) =>
  deleteSessionEntryLifecycle({
    ...scope,
    target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    archiveTranscript: true,
  });

function sessionReaders(scope: SessionScope) {
  return {
    metadata: (sessionId: string, sessionKey?: string) =>
      loadMemorySessionMetadataAsync({ ...scope, sessionId, sessionKey }),
    batch: (...sessions: { sessionId: string; sessionKey?: string }[]) =>
      loadMemorySessionMetadataBatchAsync({ ...scope, sessions }),
    targets: (
      selectors: Omit<Parameters<typeof resolveMemorySessionTargetsAsync>[0], keyof typeof scope>,
    ) => resolveMemorySessionTargetsAsync({ ...scope, ...selectors }),
  };
}

describe("memory source sessions", () => {
  it.each(["default", "custom", "shared"])(
    "resolves metadata and deletion selectors in the %s session store",
    async (layout) => {
      await withSessionState(async (state) => {
        const storePath =
          layout === "default"
            ? resolveDefaultSessionStorePath("main")
            : path.join(
                state.root,
                "custom",
                layout === "shared" ? "sessions.sqlite" : "sessions.json",
              );
        await fs.mkdir(path.dirname(storePath), { recursive: true });
        const scope = { agentId: "main", storePath };
        const read = sessionReaders(scope);
        const sessionId = `source-${"x".repeat(300)}`;
        const sessionKey = "agent:main:source-session";
        const source = { sessionId, sessionKey, hookExternalContentSource: "gmail" };
        const live = [{ sessionId, sessionKey, resolution: "live" }];
        await upsertSessionEntryCore(
          { ...scope, sessionKey },
          {
            ...sessionEntry(sessionId, "gmail"),
            sessionStartedAt: 1_000,
            chatType: "group",
          },
        );
        recordSessionParticipant(
          { ...scope, sessionKey },
          { identity: { type: "profile", id: "profile-source" } },
        );
        await closeDatabases();

        expect(await read.metadata(sessionId, sessionKey)).toMatchObject({
          ...source,
          chatType: "group",
        });
        expect(await read.batch({ sessionId, sessionKey }, { sessionId: "missing" })).toMatchObject(
          [source],
        );
        expect(await read.batch({ sessionId, sessionKey: "agent:main:another-session" })).toEqual(
          [],
        );
        expect(resolveMemorySessionTargets({ ...scope, sessionIds: [sessionId] })).toMatchObject(
          live,
        );
        await withoutHostSql(async () => {
          expect(await read.metadata(sessionId)).toMatchObject(source);
          expect(await read.targets({ participants: ["profile-source"] })).toMatchObject(live);
        });
        for (const selectors of [
          { sessionIds: [sessionId] },
          { sessionIds: [sessionKey] },
          { hookSources: ["gmail"] },
          { participants: ["profile-source"] },
        ]) {
          expect(await read.targets(selectors)).toMatchObject(live);
        }
        expect(await read.targets({ sessionIds: [sessionId], since: 2_000 })).toEqual([]);
        expect(await read.targets({ sessionIds: ["unknown"], since: 2_000 })).toMatchObject([
          { sessionId: "unknown", resolution: "unresolved" },
        ]);

        await appendUserMessage({ ...scope, sessionId, sessionKey }, "archive");
        const deletion = await archive(scope, sessionKey);
        await closeDatabases();
        const archiveName = path.basename(deletion.archivedTranscripts[0]?.archivedPath ?? "");
        expect(loadArchivedSessions({ ...scope, sessionIds: [sessionKey] })).toMatchObject([
          { sessionId, sessionKey },
        ]);
        const expectedArchives = loadArchivedSessions({ ...scope, archiveNames: [archiveName] });
        await withoutHostSql(async () => {
          expect(
            await loadArchivedSessionsAsync({ ...scope, archiveNames: [archiveName] }),
          ).toEqual(expectedArchives);
        });
        expect(expectedArchives).toMatchObject([{ archiveName, sessionId, sessionKey }]);
        expect(await read.targets({ sessionIds: [sessionKey] })).toMatchObject([
          { sessionId, sessionKey, resolution: "archived" },
        ]);
        expect(await read.targets({ hookSources: ["gmail"] })).toEqual([]);
      });
    },
  );

  it("keeps another agent's live and archived sources out of a shared store selection", async () => {
    await withSessionState(async (state) => {
      const storePath = path.join(state.root, "shared.sqlite");
      const mainScope = { agentId: "main", storePath };
      const read = sessionReaders(mainScope);
      for (const agentId of ["main", "other"]) {
        const sessionId = `${agentId}-source`;
        const sessionKey = `agent:${agentId}:source`;
        const scope = { agentId, storePath, sessionId, sessionKey };
        await upsertSessionEntryCore(scope, sessionEntry(sessionId, "gmail"));
        recordSessionParticipant(scope, {
          identity: { type: "profile", id: "same-participant" },
        });
        await appendUserMessage(scope, agentId);
      }
      for (const selectors of [
        { hookSources: ["gmail"] },
        { participants: ["same-participant"] },
      ]) {
        expect(await read.targets(selectors)).toMatchObject([{ sessionId: "main-source" }]);
      }
      expect(await read.metadata("other-source", "agent:other:source")).toBeUndefined();
      expect(
        await read.batch({ sessionId: "other-source", sessionKey: "agent:other:source" }),
      ).toEqual([]);
      await archive({ agentId: "other", storePath }, "agent:other:source");
      expect(
        await loadArchivedSessionsAsync({ ...mainScope, sessionIds: ["other-source"] }),
      ).toEqual([]);
    });
  });

  it("selects the exact recorded email source without conflating webhooks", async () => {
    await withSessionState(async () => {
      const read = sessionReaders({ agentId: "main" });
      for (const source of ["email", "webhook"] as const) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: `agent:main:${source}` },
          sessionEntry(source, source),
        );
      }
      await closeDatabases();
      for (const source of ["email", "webhook"] as const) {
        expect(await read.metadata(source)).toMatchObject({
          hookExternalContentSource: source,
        });
        expect(await read.targets({ hookSources: [source] })).toMatchObject([
          { sessionId: source, hookExternalContentSource: source },
        ]);
      }
      const batch = [{ sessionId: "email" }, { sessionId: "webhook" }];
      expect(await read.batch(...batch)).toMatchObject([
        { sessionId: "email", hookExternalContentSource: "email" },
        { sessionId: "webhook", hookExternalContentSource: "webhook" },
      ]);
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:email" },
        {
          ...sessionEntry("email", "email", 1_001),
          chatType: "group",
        },
      );
      expect(await read.batch(...batch)).toContainEqual(
        expect.objectContaining({ sessionId: "email", chatType: "group" }),
      );
      const emailScope = { agentId: "main", sessionKey: "agent:main:email" };
      await appendUserMessage({ ...emailScope, sessionId: "email" }, "email");
      await replaceSessionEntry(emailScope, { sessionId: "replacement", updatedAt: 2_000 });
      expect(await read.metadata("email")).toMatchObject({
        hookExternalContentSource: null,
      });
      expect(await read.batch(...batch)).toContainEqual(
        expect.objectContaining({ sessionId: "email", hookExternalContentSource: null }),
      );
      expect(await read.targets({ hookSources: ["webhook"] })).toMatchObject([
        { sessionId: "webhook" },
      ]);
      expect(
        listSessionTranscriptInstances({ agentId: "main" }).find(
          (instance) => instance.sessionId === "email",
        )?.entry.hookExternalContentSource,
      ).toBe("webhook");
    });
  });

  it("does not create an absent configured session store while inspecting sources", async () => {
    await withSessionState(async (state) => {
      const storePath = path.join(state.root, "absent", "sessions.json");
      const scope = { agentId: "main", storePath };
      const read = sessionReaders(scope);
      expect(await read.metadata("missing")).toBeUndefined();
      expect(await read.batch({ sessionId: "missing" })).toEqual([]);
      expect(await loadArchivedSessionsAsync({ ...scope, sessionIds: ["missing"] })).toEqual([]);
      expect(await read.targets({ sessionIds: ["missing"] })).toMatchObject([
        { sessionId: "missing", resolution: "unresolved" },
      ]);
      await expect(fs.stat(path.dirname(storePath))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
  it("refuses archive inventory after its retained database closes", async () => {
    await withSessionState(async (state) => {
      const scope = { agentId: "main", storePath: resolveDefaultSessionStorePath("main") };
      await upsertSessionEntryCore(
        { ...scope, sessionKey: "agent:main:inventory" },
        { sessionId: "inventory", updatedAt: 1 },
      );
      const entered = createDeferred();
      const release = createDeferred();
      const createReaders = historyReaders.createSessionHistoryWorkerReaders;
      const factory = vi
        .spyOn(historyReaders, "createSessionHistoryWorkerReaders")
        .mockImplementation((run) => {
          const readers = createReaders(run);
          return {
            ...readers,
            readArchiveInventory: async (input) => {
              const entries = await readers.readArchiveInventory(input);
              entered.resolve();
              await release.promise;
              return entries;
            },
          };
        });
      const outcome = loadArchivedSessionsAsync({ ...scope, sessionIds: ["inventory"] }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      let closing: Promise<void> | undefined;
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          outcome,
          "Inventory settled before the retained read",
        );
        closing = closeOpenClawAgentDatabasesAsync(state.stateDir);
        release.resolve();
        expect(await outcome).toMatchObject({
          error: { message: expect.stringMatching(/revoked/) },
        });
        await closing;
      } finally {
        release.resolve();
        await Promise.allSettled([outcome, closing]);
        factory.mockRestore();
      }
    });
  });
});
