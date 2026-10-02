import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../../config/sessions/session-accessor.sqlite-entry-store.js";
import { recordSessionParticipantBestEffort } from "../../../sessions/session-participant-recording.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { prepareSubagentSessionContext } from "./subagent-spawn-context.js";
import { createInitialSubagentSession } from "./subagent-spawn-session-patch.js";
import * as spawnRuntime from "./subagent-spawn.runtime.js";

it("inherits accepted human credit when participant persistence is still queued", async () => {
  await withOpenClawTestState({ label: "spawn-pending-participant" }, async (state) => {
    const agentId = "main";
    const sessionKey = "agent:main:parent";
    const childSessionKey = "agent:main:subagent:child";
    const storePath = resolveOpenClawAgentSqlitePath({ agentId });
    const scope = { agentId, sessionKey, storePath };
    await upsertSessionEntryCore(scope, { sessionId: "parent-id", updatedAt: 1 });
    const releaseWriter = createDeferredCore();
    const writerStarted = createDeferredCore();
    const heldWriter = runOpenClawAgentWriteAdmission({ agentId, path: storePath }, async () => {
      writerStarted.resolve();
      await releaseWriter.promise;
    });
    await writerStarted.promise;
    const work = new AsyncWorkScope();
    const errors: unknown[] = [];
    try {
      work.run(() =>
        recordSessionParticipantBestEffort({
          ...scope,
          storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
          identity: { type: "profile", id: "human-requester" },
          promptedAt: 1,
          onError: (error) => errors.push(error),
        }),
      );
      // The real recorder defers its write to the next microtask. Keep that original order.
      await Promise.resolve();
      expect(loadSessionEntry(scope)?.participants ?? []).toEqual([]);
      const creation = createInitialSubagentSession({
        cfg: {},
        targetAgentId: agentId,
        childSessionKey,
        incognito: false,
        requesterInternalKey: sessionKey,
        creationPolicy: { actor: { type: "agent", id: agentId } },
        completionOwnerSessionKey: sessionKey,
        modelPatch: {},
        collect: false,
      });
      releaseWriter.resolve();
      await heldWriter;
      expect(await creation).toMatchObject({ status: "ok" });
      await work.drain();

      expect(errors).toEqual([]);
      expect(loadSessionEntry(scope)?.participants).toEqual([
        { identity: { type: "profile", id: "human-requester" } },
      ]);
      const child = loadSessionEntry({ ...scope, sessionKey: childSessionKey });
      expect(child?.inheritedGitContributorProfileIds).toEqual(["human-requester"]);
      expect(child?.participants ?? []).toEqual([]);
    } finally {
      releaseWriter.resolve();
      await heldWriter;
      await work.drain();
    }
  });
});

it.each(["creation", "fork"] as const)(
  "keeps the selected physical store when its alias changes before child %s",
  async (operation) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const agentId = "main";
      const parentSessionKey = "agent:main:parent";
      const childSessionKey = "agent:main:subagent:retarget-child";
      const original = openOpenClawAgentDatabase({
        agentId,
        path: state.statePath("original", "store.sqlite"),
      });
      const successor = openOpenClawAgentDatabase({
        agentId,
        path: state.statePath("successor", "store.sqlite"),
      });
      for (const [database, source] of [
        [original, "original"],
        [successor, "successor"],
      ] as const) {
        const sessionId = `${source}-parent`;
        writeSessionEntry(database, parentSessionKey, {
          sessionId,
          updatedAt: 1,
          totalTokens: 1,
          totalTokensFresh: true,
          totalTokensVersion: 1,
        });
        if (operation === "fork") {
          await replaceTranscriptEvents(
            { agentId, sessionKey: parentSessionKey, sessionId, storePath: database.path },
            [
              { type: "session", version: 3, id: sessionId, timestamp: "2026-09-26T00:00:00Z" },
              {
                type: "message",
                id: "user-message",
                parentId: null,
                message: { role: "user", content: `${source} context` },
              },
              {
                type: "message",
                id: "assistant-message",
                parentId: "user-message",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: `${source} reply` }],
                  api: "openai-responses",
                  provider: "openai",
                  model: "gpt-5.4",
                  stopReason: "stop",
                  timestamp: 1,
                },
              },
            ],
          );
        }
      }
      const alias = state.statePath("selected");
      const heldAlias = state.statePath("selected-before");
      const linkType = process.platform === "win32" ? "junction" : "dir";
      await fs.symlink(path.dirname(original.path), alias, linkType);
      const cfg = { session: { store: path.join(alias, "store.sqlite") } };
      const resolveTarget = spawnRuntime.resolveGatewaySessionStoreTargetInWorker;
      let aliasMoved = false;
      const selected = vi
        .spyOn(spawnRuntime, "resolveGatewaySessionStoreTargetInWorker")
        .mockImplementation(async (params) => {
          const target = await resolveTarget(params);
          const lastSelectionKey = operation === "creation" ? childSessionKey : parentSessionKey;
          if (params.key === lastSelectionKey) {
            expect(target.readSource?.path).toBe(original.path);
            await fs.rename(alias, heldAlias);
            aliasMoved = true;
            await fs.symlink(path.dirname(successor.path), alias, linkType);
          }
          return target;
        });
      try {
        const result =
          operation === "creation"
            ? await createInitialSubagentSession({
                cfg,
                targetAgentId: agentId,
                childSessionKey,
                incognito: false,
                requesterInternalKey: parentSessionKey,
                creationPolicy: { actor: { type: "agent", id: agentId } },
                completionOwnerSessionKey: parentSessionKey,
                modelPatch: {},
                collect: false,
              })
            : await prepareSubagentSessionContext({
                cfg,
                contextMode: "fork",
                requesterAgentId: agentId,
                targetAgentId: agentId,
                requesterInternalKey: parentSessionKey,
                childSessionKey,
              });
        expect(result).toMatchObject({ status: "ok" });
        expect(aliasMoved).toBe(true);
        const originalChild = loadSessionEntry({
          agentId,
          sessionKey: childSessionKey,
          storePath: original.path,
        });
        const successorChild = loadSessionEntry({
          agentId,
          sessionKey: childSessionKey,
          storePath: successor.path,
        });
        expect({
          original: originalChild?.sessionId,
          successor: successorChild?.sessionId,
        }).toEqual({
          original: expect.any(String),
          successor: undefined,
        });
        if (operation === "fork") {
          expect(result).toMatchObject({ mode: "fork" });
          expect(
            await loadTranscriptEvents({
              agentId,
              sessionKey: childSessionKey,
              sessionId: originalChild!.sessionId,
              storePath: original.path,
            }),
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "message",
                message: { role: "user", content: "original context" },
              }),
            ]),
          );
        }
      } finally {
        selected.mockRestore();
        if (aliasMoved) {
          await fs.rm(alias, { recursive: true, force: true });
          await fs.rename(heldAlias, alias);
        }
      }
    });
  },
);
