import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { cleanupSessionLifecycleArtifactsCore } from "../config/sessions/session-accessor.sqlite-artifact-cleanup.js";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.sqlite-lifecycle.js";
import {
  forkSessionAtMessage,
  rewindSessionToMessage,
  switchSessionBranch,
} from "../config/sessions/session-accessor.sqlite-message-cut.js";
import {
  readSqliteSessionArchivePruning,
  withSqliteSessionPageReclamation,
} from "../config/sessions/session-accessor.sqlite-page-reclamation.js";
import {
  forkSessionEntryFromParentTargetWithPatch,
  forkSessionTranscriptFromParent,
  prepareSessionForkTranscript,
} from "../config/sessions/session-accessor.sqlite-parent-session.js";
import { restoreSessionColdTranscript } from "../config/sessions/session-cold-storage.js";
import {
  readSessionEntryReadOnlyInWorker,
  withSessionEntryReadOnlyInWorker,
} from "../config/sessions/session-entry-read-runtime.js";
import {
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "../config/sessions/session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import type { IncognitoLifecycleEntry } from "../config/sessions/session-incognito-lifecycle-contract.js";
import type { IncognitoTranscriptOperations } from "../config/sessions/session-incognito-transcript-contract.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { IncognitoSessionEndedError } from "./incognito-session-error.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";

type LifecycleFacadeFixture = {
  readonly actor: IncognitoAgentDatabaseExecution;
  readonly env: NodeJS.ProcessEnv;
  authority: IncognitoSessionAuthority;
  create(this: void, name: string): Promise<IncognitoLifecycleEntry>;
  append(
    this: void,
    target: IncognitoLifecycleEntry,
    content: string,
  ): Promise<IncognitoTranscriptOperations["session.message.append"]["output"]>;
};

export function registerIncognitoLifecycleSourceTests(
  fixture: Pick<LifecycleFacadeFixture, "env" | "authority" | "actor" | "create">,
) {
  const { authority } = fixture;
  it.each(["before", "after"] as const)(
    "refuses deletion when captured admission closes %s its entry read",
    async (phase) => {
      const { actor, env } = fixture;
      const target = await fixture.create(`delete-read-canceled-${phase}`);
      const controller = new AbortController();
      const failure = new Error("synthetic deletion preparation canceled");
      const read = actor.sessions.read;
      const observation =
        phase === "after"
          ? vi.spyOn(actor.sessions, "read").mockImplementationOnce(async (...args) => {
              const result = await read(...args);
              controller.abort(failure);
              return result;
            })
          : undefined;
      try {
        const pending = withIncognitoSessionBinding(
          { actor, admissionSignal: controller.signal },
          () =>
            deleteSessionEntryLifecycle({
              agentId: actor.agentId,
              env,
              storePath: actor.path,
              target: { canonicalKey: target.sessionKey, storeKeys: [target.sessionKey] },
              archiveTranscript: false,
              deleteTranscriptWithoutArchive: true,
              expectedEntry: target.entry,
            }),
        );
        if (phase === "before") {
          controller.abort(failure);
        }
        await expect(pending).rejects.toBe(failure);
        expect(
          (await actor.sessions.read(authority, { sessionKey: target.sessionKey })).entry
            ?.sessionId,
        ).toBe(target.entry.sessionId);
      } finally {
        observation?.mockRestore();
      }
    },
  );
  it.each(["deletion", "cleanup"] as const)(
    "settles committed %s when its admission closes during publication",
    async (operation) => {
      const { actor, env } = fixture;
      const target = await fixture.create(`committed-cancellation-${operation}`);
      const controller = new AbortController();
      let publications = 0;
      const stop = onSessionIdentityMutation((mutation) => {
        if (mutation.kind === "delete" && mutation.previous.sessionId === target.entry.sessionId) {
          publications++;
          controller.abort(new Error("synthetic lifecycle publication canceled admission"));
        }
      });
      try {
        const pending = withIncognitoSessionBinding(
          { actor, admissionSignal: controller.signal },
          () =>
            operation === "deletion"
              ? deleteSessionEntryLifecycle({
                  agentId: actor.agentId,
                  env,
                  storePath: actor.path,
                  target: { canonicalKey: target.sessionKey, storeKeys: [target.sessionKey] },
                  archiveTranscript: false,
                  deleteTranscriptWithoutArchive: true,
                  expectedEntry: target.entry,
                })
              : cleanupSessionLifecycleArtifactsCore({
                  agentId: actor.agentId,
                  env,
                  storePath: actor.path,
                  sessionKeySegmentPrefix: "dashboard:incognito-committed-cancellation-cleanup",
                  transcriptContentMarker: "synthetic committed cleanup",
                  orphanTranscriptMinAgeMs: 0,
                  nowMs: Date.now() + 86_400_000,
                }),
        );
        await expect(pending).resolves.toMatchObject(
          operation === "deletion"
            ? { deleted: true, deletedSessionId: target.entry.sessionId }
            : { removedEntries: 1, archivedTranscriptArtifacts: 0 },
        );
        expect(controller.signal.aborted).toBe(true);
        expect(publications).toBe(1);
        expect(
          (await actor.sessions.read(authority, { sessionKey: target.sessionKey })).entry,
        ).toBeUndefined();
      } finally {
        stop();
      }
    },
  );
  it("returns fresh missing lifecycle results without disk discovery and fences a later actor", async () => {
    const { env } = fixture;
    const agentId = "missing-lifecycle";
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env });
    const sessionKey = `agent:${agentId}:dashboard:incognito-missing`;
    const scope = { agentId, env, storePath, sessionKey };
    const parentEntry = { sessionId: "missing-parent", updatedAt: 1, incognito: true as const };
    const missing = { kind: "absent" as const, agentId, env, authority };
    await withIncognitoSessionBinding(missing, async () => {
      const sql = observeHostDataSql();
      try {
        expect(await readSessionEntryReadOnlyInWorker(scope)).toBeUndefined();
        expect(await rewindSessionToMessage({ ...scope, entryId: "missing" })).toEqual({
          status: "missing-session",
        });
        await expect(
          readSessionEntryReadOnlyInWorker({
            ...scope,
            env: { OPENCLAW_STATE_DIR: path.join(env.OPENCLAW_STATE_DIR!, "another-root") },
          }),
        ).rejects.toThrow("state root");
        expect(
          await deleteSessionEntryLifecycle({
            ...scope,
            target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
            archiveTranscript: true,
          }),
        ).toEqual({ deleted: false, archivedTranscripts: [] });
        const fork = { ...scope, parentSessionKey: sessionKey, parentEntry };
        expect(await prepareSessionForkTranscript(fork)).toEqual({ status: "missing-parent" });
        expect(await forkSessionTranscriptFromParent(fork)).toEqual({ status: "missing-parent" });
        expect(
          await forkSessionEntryFromParentTargetWithPatch({
            agentId,
            storePath,
            parentTarget: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
            sessionTarget: {
              canonicalKey: `${sessionKey}-child`,
              storeKeys: [`${sessionKey}-child`],
            },
          }),
        ).toEqual({ status: "missing-parent" });
        await restoreSessionColdTranscript({ ...scope, sessionId: parentEntry.sessionId });
        expect(await readSqliteSessionArchivePruning({ agentId, env, path: storePath })).toBeNull();
        const reclaim = vi.fn();
        await expect(
          withSqliteSessionPageReclamation({ agentId, env, path: storePath }, reclaim),
        ).rejects.toThrow("no disk pages or archives");
        expect(reclaim).not.toHaveBeenCalled();
        expect(
          await cleanupSessionLifecycleArtifactsCore({
            ...scope,
            sessionKeySegmentPrefix: "dashboard:incognito-",
            transcriptContentMarker: "synthetic missing lifecycle",
            orphanTranscriptMinAgeMs: 0,
          }),
        ).toEqual({ removedEntries: 0, archivedTranscriptArtifacts: 0 });
        expect(existsSync(storePath)).toBe(false);
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
    });

    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const pending = withIncognitoSessionBinding(missing, () =>
      withSessionEntryReadOnlyInWorker(
        scope,
        () => {},
        async (read) => {
          expect(read).toEqual({ ok: true, value: undefined });
          entered.resolve();
          await resume.promise;
        },
      ),
    );
    await entered.promise;
    let created: IncognitoAgentDatabaseExecution | undefined;
    try {
      created = await captureOpenClawAgentDatabaseExecution({
        kind: "ephemeral",
        agentId,
        env,
        authority,
      });
      assert(created);
      await created.close();
      expect(
        captureOpenClawAgentDatabaseExecution
          .listIncognito(env)
          .some((owner) => owner.agentId === agentId),
      ).toBe(false);
      expect(
        await withIncognitoSessionBinding(missing, () => readSessionEntryReadOnlyInWorker(scope)),
      ).toBeUndefined();
      const refused = expect(pending).rejects.toThrow("absence changed");
      resume.resolve();
      await refused;
      await expect(
        withIncognitoSessionBinding({ actor: created }, () =>
          readSessionEntryReadOnlyInWorker(scope),
        ),
      ).rejects.toBeInstanceOf(IncognitoSessionEndedError);
    } finally {
      resume.resolve();
      await pending.catch(() => undefined);
      await created?.close();
    }
  });
  it.each(["borrowed-authority", "admission-signal"] as const)(
    "rechecks cleanup %s after actor preparation before deleting",
    async (revocation) => {
      const { actor, env } = fixture;
      const target = await fixture.create(`cleanup-authority-${revocation}`);
      const admission = new AbortController();
      const failure = new Error("synthetic cleanup authority revoked");
      let revoked = false;
      const borrowed = await captureOpenClawAgentDatabaseExecution({
        kind: "ephemeral",
        agentId: actor.agentId,
        env,
        existingOnly: true,
        authority: {
          assertCurrent() {
            if (revoked) {
              throw failure;
            }
          },
        },
      });
      assert(borrowed);
      const lifecycle = borrowed.sessions.lifecycle;
      let prepared = false;
      const observation = vi.spyOn(borrowed.sessions, "lifecycle").mockImplementation((...args) =>
        lifecycle(...args).then((value) => {
          if (args[1].type === "session.lifecycle.reclaim.prepare") {
            prepared = true;
            if (revocation === "borrowed-authority") {
              revoked = true;
            } else {
              admission.abort(failure);
            }
          }
          return value;
        }),
      );
      try {
        await expect(
          withIncognitoSessionActor(
            borrowed,
            () =>
              cleanupSessionLifecycleArtifactsCore({
                agentId: actor.agentId,
                env,
                storePath: actor.path,
                sessionKeySegmentPrefix: `dashboard:incognito-cleanup-authority-${revocation}`,
                transcriptContentMarker: "synthetic cleanup authority",
                orphanTranscriptMinAgeMs: 0,
                nowMs: Date.now() + 86_400_000,
              }),
            admission.signal,
          ),
        ).rejects.toBe(failure);
        expect(prepared).toBe(true);
        expect(
          (await actor.sessions.read(authority, { sessionKey: target.sessionKey })).entry
            ?.sessionId,
        ).toBe(target.entry.sessionId);
      } finally {
        observation.mockRestore();
        await borrowed.release();
      }
    },
  );
}

export function registerIncognitoMessageCutTests(fixture: LifecycleFacadeFixture) {
  const { authority, create, append } = fixture;
  it.each(["preparation", "commit publication"] as const)(
    "settles a message cut when admission closes during %s",
    async (stage) => {
      const { actor, env } = fixture;
      const target = await create(`cut-cancel-${stage.replaceAll(" ", "-")}`);
      const user = await actor.sessions.transcript(authority, {
        type: "session.message.append",
        input: {
          sessionKey: target.sessionKey,
          sessionId: target.entry.sessionId,
          fence: {},
          message: { role: "user", content: "captured turn", timestamp: 10_001 },
        },
      });
      assert(user.ok && user.value.append);
      const targetKey = `${target.sessionKey}-fork`;
      const controller = new AbortController();
      const reason = new Error("Cut admission closed");
      const read = actor.sessions.read;
      const pausedRead =
        stage === "preparation"
          ? vi.spyOn(actor.sessions, "read").mockImplementationOnce(async (...args) => {
              const result = await read(...args);
              controller.abort(reason);
              return result;
            })
          : undefined;
      const stop = sessionChanges.subscribe((change) => {
        if (
          stage === "commit publication" &&
          "sessionKey" in change &&
          change.sessionKey === targetKey
        ) {
          controller.abort(reason);
        }
      });
      try {
        const pending = withIncognitoSessionBinding(
          { actor, admissionSignal: controller.signal },
          () =>
            forkSessionAtMessage({
              agentId: actor.agentId,
              env,
              storePath: actor.path,
              sessionKey: target.sessionKey,
              targetKey,
              entryId: user.value.append!.messageId,
            }),
        );
        if (stage === "preparation") {
          await expect(pending).rejects.toBe(reason);
        } else {
          await expect(pending).resolves.toMatchObject({ status: "created", key: targetKey });
        }
        expect(controller.signal.aborted).toBe(true);
        const child = await read(authority, { sessionKey: targetKey });
        expect(Boolean(child.entry)).toBe(stage === "commit publication");
      } finally {
        pausedRead?.mockRestore();
        stop();
      }
    },
  );
  it("forks and rewinds actor history through checked message-cut facades", async () => {
    const { actor, env } = fixture;
    const target = await create("message-cut");
    const first = await append(target, "retained answer");
    assert(first.ok && first.value.append);
    const user = await actor.sessions.transcript(authority, {
      type: "session.message.append",
      input: {
        sessionKey: target.sessionKey,
        sessionId: target.entry.sessionId,
        fence: {},
        message: { role: "user", content: "edit this turn", timestamp: 10_001 },
      },
    });
    assert(user.ok && user.value.append);
    const last = await append(target, "answer to remove");
    assert(last.ok && last.value.append);
    const scope = {
      agentId: actor.agentId,
      storePath: actor.path,
      env,
      sessionKey: target.sessionKey,
    };
    const registry = createEmptyPluginRegistry();
    markPluginRegistryActive(registry);
    const sql = observeHostDataSql();
    try {
      await withPluginRuntimeRegistryScope(registry, () =>
        withIncognitoSessionActor(actor, async () => {
          expect(
            await forkSessionAtMessage(
              {
                ...scope,
                targetKey: `${target.sessionKey}-fork`,
                entryId: user.value.append!.messageId,
              },
              { sessionId: "stale" },
            ),
          ).toEqual({ status: "conflict" });
          const fork = await forkSessionAtMessage({
            ...scope,
            targetKey: `${target.sessionKey}-fork`,
            entryId: user.value.append!.messageId,
          });
          assert(fork.status === "created");
          expect(fork.editorText).toBe("edit this turn");
          const history = await actor.sessions.history(authority, {
            type: "session.history.hydrate",
            input: {
              sessionKey: fork.key,
              sessionId: fork.entry.sessionId,
              lifecycleRevision: fork.entry.lifecycleRevision,
            },
          });
          assert(history.kind === "full");
          expect(history.snapshot.events).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: first.value.append!.messageId }),
            ]),
          );
          expect(history.snapshot.events).not.toEqual(
            expect.arrayContaining([expect.objectContaining({ id: user.value.append!.messageId })]),
          );
          expect(
            (await actor.sessions.read(authority, { sessionKey: target.sessionKey })).entry
              ?.sessionId,
          ).toBe(target.entry.sessionId);
          const rewind = await rewindSessionToMessage({
            ...scope,
            entryId: user.value.append!.messageId,
          });
          assert(rewind.status === "created");
          expect(actor.sessions.readSharing(target.sessionKey)?.entry?.sessionId).toBe(
            rewind.entry.sessionId,
          );
          const switched = await switchSessionBranch({
            ...scope,
            leafEntryId: last.value.append!.messageId,
          });
          expect(switched.status).toBe("created");
        }),
      );
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
      markPluginRegistryRetired(registry);
    }
  });
}
