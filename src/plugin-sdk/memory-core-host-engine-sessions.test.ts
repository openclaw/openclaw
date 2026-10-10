import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createDeferred, awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
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
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  loadArchivedSessions,
  loadArchivedSessionsAsync,
  loadMemorySessionMetadata,
  loadMemorySessionMetadataBatch,
  resolveMemorySessionTargets,
  resolveMemorySessionTargetsAsync,
} from "./memory-core-host-engine-sessions.js";

describe("memory source sessions", () => {
  it.each(["default", "custom", "shared"])(
    "resolves metadata and deletion selectors in the %s session store",
    async (layout) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
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
        const sessionId = `source-${"x".repeat(300)}`;
        const sessionKey = "agent:main:source-session";
        await upsertSessionEntryCore(
          { ...scope, sessionKey },
          {
            sessionId,
            sessionStartedAt: 1_000,
            updatedAt: 1_000,
            chatType: "group",
            hookExternalContentSource: "gmail",
          },
        );
        recordSessionParticipant(
          { ...scope, sessionKey },
          { identity: { type: "profile", id: "profile-source" } },
        );
        await closeOpenClawAgentDatabasesAsync();
        closeOpenClawAgentDatabasesForTest();

        expect(loadMemorySessionMetadata({ ...scope, sessionId, sessionKey })).toMatchObject({
          sessionId,
          sessionKey,
          hookExternalContentSource: "gmail",
          chatType: "group",
        });
        expect(
          loadMemorySessionMetadataBatch({
            ...scope,
            sessions: [{ sessionId, sessionKey }, { sessionId: "missing" }],
          }),
        ).toEqual([
          expect.objectContaining({ sessionId, sessionKey, hookExternalContentSource: "gmail" }),
        ]);
        expect(
          loadMemorySessionMetadataBatch({
            ...scope,
            sessions: [{ sessionId, sessionKey: "agent:main:another-session" }],
          }),
        ).toEqual([]);
        expect(resolveMemorySessionTargets({ ...scope, sessionIds: [sessionId] })).toEqual([
          expect.objectContaining({ sessionId, sessionKey, resolution: "live" }),
        ]);
        const targetSql = observeHostDataSql();
        try {
          expect(
            await resolveMemorySessionTargetsAsync({ ...scope, participants: ["profile-source"] }),
          ).toEqual([expect.objectContaining({ sessionId, sessionKey, resolution: "live" })]);
          expect(targetSql.queries).toEqual([]);
          for (const call of targetSql.calls) {
            expect(call).not.toHaveBeenCalled();
          }
        } finally {
          targetSql.restore();
        }
        for (const selectors of [
          { sessionIds: [sessionId] },
          { sessionIds: [sessionKey] },
          { hookSources: ["gmail"] },
          { participants: ["profile-source"] },
        ]) {
          expect(await resolveMemorySessionTargetsAsync({ ...scope, ...selectors })).toEqual([
            expect.objectContaining({ sessionId, sessionKey, resolution: "live" }),
          ]);
        }
        expect(
          await resolveMemorySessionTargetsAsync({
            ...scope,
            sessionIds: [sessionId],
            since: 2_000,
          }),
        ).toEqual([]);
        expect(
          await resolveMemorySessionTargetsAsync({
            ...scope,
            sessionIds: ["unknown"],
            since: 2_000,
          }),
        ).toEqual([expect.objectContaining({ sessionId: "unknown", resolution: "unresolved" })]);

        await appendTranscriptMessage(
          { ...scope, sessionId, sessionKey },
          { message: { role: "user", content: "Retain this source as an archive." } },
        );
        const deletion = await deleteSessionEntryLifecycle({
          ...scope,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          archiveTranscript: true,
        });
        await closeOpenClawAgentDatabasesAsync();
        closeOpenClawAgentDatabasesForTest();
        const archiveName = path.basename(deletion.archivedTranscripts[0]?.archivedPath ?? "");
        expect(loadArchivedSessions({ ...scope, sessionIds: [sessionKey] })).toEqual([
          expect.objectContaining({ sessionId, sessionKey }),
        ]);
        const expectedArchives = loadArchivedSessions({ ...scope, archiveNames: [archiveName] });
        const hostSql = observeHostDataSql();
        try {
          expect(
            await loadArchivedSessionsAsync({ ...scope, archiveNames: [archiveName] }),
          ).toEqual(expectedArchives);
          expect(hostSql.queries).toEqual([]);
          for (const call of hostSql.calls) {
            expect(call).not.toHaveBeenCalled();
          }
        } finally {
          hostSql.restore();
        }
        expect(expectedArchives).toEqual([
          expect.objectContaining({ archiveName, sessionId, sessionKey }),
        ]);
        expect(
          await resolveMemorySessionTargetsAsync({ ...scope, sessionIds: [sessionKey] }),
        ).toEqual([expect.objectContaining({ sessionId, sessionKey, resolution: "archived" })]);
        expect(
          await resolveMemorySessionTargetsAsync({ ...scope, hookSources: ["gmail"] }),
        ).toEqual([]);
      });
    },
  );

  it("keeps another agent's live and archived sources out of a shared store selection", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = path.join(state.root, "shared.sqlite");
      const mainScope = { agentId: "main", storePath };
      for (const agentId of ["main", "other"]) {
        const sessionId = `${agentId}-source`;
        const sessionKey = `agent:${agentId}:source`;
        const scope = { agentId, storePath, sessionId, sessionKey };
        await upsertSessionEntryCore(scope, {
          sessionId,
          updatedAt: 1_000,
          hookExternalContentSource: "gmail",
        });
        recordSessionParticipant(scope, {
          identity: { type: "profile", id: "same-participant" },
        });
        await appendTranscriptMessage(scope, { message: { role: "user", content: agentId } });
      }
      for (const selectors of [
        { hookSources: ["gmail"] },
        { participants: ["same-participant"] },
      ]) {
        expect(await resolveMemorySessionTargetsAsync({ ...mainScope, ...selectors })).toEqual([
          expect.objectContaining({ sessionId: "main-source" }),
        ]);
      }
      expect(
        loadMemorySessionMetadata({
          ...mainScope,
          sessionId: "other-source",
          sessionKey: "agent:other:source",
        }),
      ).toBeUndefined();
      expect(
        loadMemorySessionMetadataBatch({
          ...mainScope,
          sessions: [{ sessionId: "other-source", sessionKey: "agent:other:source" }],
        }),
      ).toEqual([]);
      await deleteSessionEntryLifecycle({
        agentId: "other",
        storePath,
        target: { canonicalKey: "agent:other:source", storeKeys: ["agent:other:source"] },
        archiveTranscript: true,
      });
      expect(
        await loadArchivedSessionsAsync({ ...mainScope, sessionIds: ["other-source"] }),
      ).toEqual([]);
    });
  });

  it("selects the exact recorded email source without conflating webhooks", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      for (const source of ["email", "webhook"] as const) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: `agent:main:${source}` },
          { sessionId: source, updatedAt: 1_000, hookExternalContentSource: source },
        );
      }
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      for (const source of ["email", "webhook"] as const) {
        expect(loadMemorySessionMetadata({ agentId: "main", sessionId: source })).toMatchObject({
          hookExternalContentSource: source,
        });
        expect(
          await resolveMemorySessionTargetsAsync({ agentId: "main", hookSources: [source] }),
        ).toEqual([
          expect.objectContaining({ sessionId: source, hookExternalContentSource: source }),
        ]);
      }
      const batch = {
        agentId: "main",
        sessions: [{ sessionId: "email" }, { sessionId: "webhook" }],
      };
      expect(loadMemorySessionMetadataBatch(batch)).toEqual([
        expect.objectContaining({ sessionId: "email", hookExternalContentSource: "email" }),
        expect.objectContaining({ sessionId: "webhook", hookExternalContentSource: "webhook" }),
      ]);
      const foreign = new DatabaseSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }));
      try {
        foreign
          .prepare("UPDATE session_windows SET chat_type = 'group' WHERE session_id = ?")
          .run("email");
      } finally {
        foreign.close();
      }
      expect(loadMemorySessionMetadataBatch(batch)).toContainEqual(
        expect.objectContaining({ sessionId: "email", chatType: "group" }),
      );
      const emailScope = { agentId: "main", sessionKey: "agent:main:email" };
      await appendTranscriptMessage(
        { ...emailScope, sessionId: "email" },
        { message: { role: "user", content: "Retained email content." } },
      );
      await replaceSessionEntry(emailScope, { sessionId: "replacement", updatedAt: 2_000 });
      expect(loadMemorySessionMetadata({ agentId: "main", sessionId: "email" })).toMatchObject({
        hookExternalContentSource: null,
      });
      expect(loadMemorySessionMetadataBatch(batch)).toContainEqual(
        expect.objectContaining({ sessionId: "email", hookExternalContentSource: null }),
      );
      expect(
        await resolveMemorySessionTargetsAsync({ agentId: "main", hookSources: ["webhook"] }),
      ).toEqual([expect.objectContaining({ sessionId: "webhook" })]);
      expect(
        listSessionTranscriptInstances({ agentId: "main" }).find(
          (instance) => instance.sessionId === "email",
        )?.entry.hookExternalContentSource,
      ).toBe("webhook");
    });
  });

  it("does not create an absent configured session store while inspecting sources", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = path.join(state.root, "absent", "sessions.json");
      const scope = { agentId: "main", storePath, sessionId: "missing" };
      expect(loadMemorySessionMetadata(scope)).toBeUndefined();
      expect(
        loadMemorySessionMetadataBatch({ ...scope, sessions: [{ sessionId: "missing" }] }),
      ).toEqual([]);
      expect(await loadArchivedSessionsAsync({ ...scope, sessionIds: ["missing"] })).toEqual([]);
      expect(await resolveMemorySessionTargetsAsync({ ...scope, sessionIds: ["missing"] })).toEqual(
        [expect.objectContaining({ sessionId: "missing", resolution: "unresolved" })],
      );
      await expect(fs.stat(path.dirname(storePath))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
  it("refuses archive inventory after its retained database closes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
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
