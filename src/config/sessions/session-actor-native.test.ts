import "../../test-utils/prepare-compiled-subprocesses.js";
import { existsSync } from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  getOpenClawAgentDatabaseIfOpen,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  deleteSessionEntryRows,
  readExactSessionEntryRow,
} from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { assignSessionOwner } from "./session-accessor.sqlite-owner.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { replaceTranscriptSuffixEventsSync } from "./session-accessor.sqlite-transcript-suffix-write.js";
import {
  appendTranscriptEventSync,
  replaceTranscriptEventsSync,
} from "./session-accessor.sqlite-transcript-write.js";
import type { SessionActorAuthority, SessionActorReducer } from "./session-actor-contract.js";
import { createSessionActorFactory } from "./session-actor-durable.js";
import {
  captureNativeIncognitoSessionActorSources,
  captureNativeIncognitoSessionActorTarget,
} from "./session-actor-native-incognito.js";
import { addSessionMember, removeSessionMember } from "./session-sharing-store.native.js";
import { deleteSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";
import { buildRestartRecoveryExpectedState } from "./session-transcript-turn-state.js";
import type { InternalSessionEntry } from "./types.js";

const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
const usage: SessionActorReducer = {
  kind: "usage",
  updatedAt: 50,
  update: {
    usage: { input: 120, output: 8 },
    modelSelection: {},
    hasUsage: true,
    hasBilling: false,
    hasContextUpdate: false,
    hasFreshContextSnapshot: false,
    hasCurrentContextSnapshot: false,
    preserveSessionModelState: true,
    preserveUserFacingRunState: false,
  },
};

async function nativeSession(env: NodeJS.ProcessEnv) {
  const database = {
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
    env,
  };
  const scope = {
    agentId: database.agentId,
    storePath: database.path,
    sessionKey: "agent:main:dashboard:incognito-native-completion",
    env,
  };
  replaceSessionEntrySync(scope, {
    sessionId: "native-session",
    updatedAt: 1,
    incognito: true,
    activeWriterRunId: "native-run",
  });
  const owner = expectDefined(getOpenClawAgentDatabaseIfOpen(database), "native owner");
  const target = expectDefined(
    captureNativeIncognitoSessionActorTarget({ database, sessionKey: scope.sessionKey }),
    "native actor target",
  );
  const factory = createSessionActorFactory(database);
  const actor = await factory.acquire(target, lifetime);
  return { actor, database, factory, owner, scope, target };
}

it("completes usage through the existing unbound native incognito owner", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const { actor, database, owner, scope, target } = await nativeSession(env);
    let callbackCount = 0;
    try {
      expect(captureOpenClawAgentDatabaseExecution.listIncognito(env)).toEqual([]);
      const before = await actor.read(authority);
      const entry = expectDefined(before.entry, "native session entry");
      const source = {
        agentId: database.agentId,
        path: database.path,
        databaseIdentity: readOpenClawAgentDatabaseIdentity(owner).identity,
      };
      const ownerSources = captureNativeIncognitoSessionActorSources({
        database,
        target,
        sources: [
          {
            source,
            sessionKey: scope.sessionKey,
            fields: ["sessionId"],
            expected: { sessionId: entry.sessionId },
          },
        ],
      });
      expect(() =>
        captureNativeIncognitoSessionActorSources({
          database,
          target,
          sources: [
            {
              source: { ...source, databaseIdentity: Symbol("other-owner") },
              sessionKey: scope.sessionKey,
              fields: [],
              expected: undefined,
            },
          ],
        }),
      ).toThrow("another database");
      const outcome = await actor.withPhase("terminal", authority, async (phase) => {
        callbackCount += 1;
        phase.patch([usage]);
        return phase.actor.completeTurn(
          {
            commandId: "native-complete",
            phaseId: "terminal",
            expected: before.version,
            turn: {
              agentId: scope.agentId,
              sessionKey: scope.sessionKey,
              ownerSources,
              options: {
                expectedSessionId: entry.sessionId,
                expectedWriterRunId: "native-run",
                expectedSessionState: buildRestartRecoveryExpectedState(entry),
                sessionLifecyclePatch: { status: "done", endedAt: 50 },
                sessionFile: "native-session.jsonl",
                messages: [],
              },
            },
          },
          authority,
        );
      });
      expect(callbackCount).toBe(1);
      expect(outcome.kind).toBe("committed");
      if (outcome.kind !== "committed") {
        throw new Error("Native completion did not commit");
      }
      expect(outcome.failure).toBeUndefined();
      expect(outcome.receipt).toMatchObject({
        commandId: "native-complete",
        phase: "completeTurn",
        beforeVersion: before.version,
        afterVersion: { epoch: before.version.epoch, sequence: before.version.sequence + 1 },
        reducers: [{ index: 0, kind: "usage", changed: true }],
        transcript: { appendedMessages: [] },
      });
      expect(actor.snapshot(authority)).toEqual(outcome.receipt.postimage);
      expect(readExactSessionEntryRow(owner, scope.sessionKey)?.entry).toMatchObject({
        incognito: true,
        inputTokens: 120,
        outputTokens: 8,
        status: "done",
        endedAt: 50,
      });
      expect(getOpenClawAgentDatabaseIfOpen(database)).toBe(owner);
      expect(captureOpenClawAgentDatabaseExecution.listIncognito(env)).toEqual([]);
      expect(existsSync(scope.storePath)).toBe(false);
      expect(existsSync(resolveOpenClawAgentSqlitePath({ agentId: scope.agentId, env }))).toBe(
        false,
      );
    } finally {
      await actor.release();
    }
  });
});

it("preserves the native committed receipt and replica when a commit observer fails", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const { actor, owner, scope } = await nativeSession(env);
    try {
      const before = await actor.read(authority);
      const committed = vi.fn(() => {
        throw new Error("native publication failed");
      });
      const outcome = await actor.patch(
        {
          commandId: "native-observer",
          phaseId: "terminal",
          expected: before.version,
          reducers: [usage],
        },
        authority,
        { committed },
      );
      expect(committed).toHaveBeenCalledOnce();
      expect(outcome.kind).toBe("committed");
      if (outcome.kind !== "committed") {
        throw new Error("Native usage did not commit");
      }
      expect(outcome.failure).toEqual({ name: "Error", message: "native publication failed" });
      expect(outcome.receipt.beforeVersion).toEqual(before.version);
      expect(actor.snapshot(authority)).toEqual(outcome.receipt.postimage);
      expect(readExactSessionEntryRow(owner, scope.sessionKey)?.entry).toMatchObject({
        inputTokens: 120,
        outputTokens: 8,
      });
    } finally {
      await actor.release();
    }
  });
});

it("refuses a captured native owner after closure instead of adopting its replacement", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const { actor, database, factory, owner, scope, target } = await nativeSession(env);
    try {
      await actor.read(authority);
      await closeOpenClawAgentDatabaseByPathAsync(database.path, database.agentId);
      expect(owner.db.isOpen).toBe(false);
      replaceSessionEntrySync(scope, {
        sessionId: "replacement-session",
        updatedAt: 2,
        incognito: true,
      });
      const replacement = expectDefined(
        getOpenClawAgentDatabaseIfOpen(database),
        "replacement owner",
      );
      expect(replacement).not.toBe(owner);
      expect(() => actor.snapshot(authority)).toThrow();
      await expect(factory.acquire(target, lifetime)).rejects.toThrow("captured owner");
      expect(readExactSessionEntryRow(replacement, scope.sessionKey)?.entry).toMatchObject({
        sessionId: "replacement-session",
        updatedAt: 2,
      });
      expect(captureOpenClawAgentDatabaseExecution.listIncognito(env)).toEqual([]);
      expect(existsSync(database.path)).toBe(false);
    } finally {
      await actor.release();
    }
  });
});

it("retains unrelated session replicas through native entry, sharing, participant, transcript, and deletion writes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const { actor, database, factory, owner, scope } = await nativeSession(env);
    const siblingScope = { ...scope, sessionKey: "agent:main:dashboard:incognito-sibling" };
    const siblingEntry = {
      sessionId: "sibling-session",
      updatedAt: 1,
      incognito: true,
    } satisfies InternalSessionEntry;
    replaceSessionEntrySync(siblingScope, siblingEntry);
    const siblingTarget = expectDefined(
      captureNativeIncognitoSessionActorTarget({ database, sessionKey: siblingScope.sessionKey }),
      "sibling actor target",
    );
    const sibling = await factory.acquire(siblingTarget, lifetime);
    try {
      const retained = await actor.read(authority);
      const siblingEvent = {
        type: "custom",
        id: "native-sibling-event",
        parentId: null,
        customType: "fixture",
        data: { value: 1 },
        timestamp: "2026-10-10T00:00:00.000Z",
      };
      const siblingTailEvent = {
        ...siblingEvent,
        id: "native-sibling-tail",
        parentId: siblingEvent.id,
      };
      const mutations = [
        () =>
          replaceSessionEntrySync(siblingScope, {
            ...siblingEntry,
            updatedAt: 2,
            label: "changed",
          }),
        () =>
          assignSessionOwner(siblingScope, {
            owner: { type: "human", id: "owner-profile" },
            assignedBy: { type: "human", id: "admin-profile" },
            assignedAt: 3,
          }),
        () =>
          addSessionMember(siblingScope, {
            identityId: "member-profile",
            addedBy: "admin-profile",
            addedAt: 4,
          }),
        () => removeSessionMember(siblingScope, "member-profile"),
        () =>
          recordSessionParticipant(siblingScope, {
            identity: { type: "agent", id: "helper-agent" },
            promptedAt: 5,
          }),
        () => {
          for (const event of [siblingEvent, siblingTailEvent]) {
            expect(
              appendTranscriptEventSync(
                { ...siblingScope, sessionId: siblingEntry.sessionId },
                event,
              ),
            ).toMatchObject({ ok: true, value: true });
          }
        },
        () =>
          expect(
            replaceTranscriptSuffixEventsSync(
              { ...siblingScope, sessionId: siblingEntry.sessionId },
              [siblingEvent, siblingTailEvent],
              [siblingEvent],
            ),
          ).toBe(true),
        () =>
          runOpenClawAgentWriteTransaction((selected) => {
            deleteSessionTranscriptIndexInTransaction(selected.db, siblingEntry.sessionId);
          }, database),
        () =>
          replaceTranscriptEventsSync({ ...siblingScope, sessionId: siblingEntry.sessionId }, []),
        () =>
          runOpenClawAgentWriteTransaction((selected) => {
            expect(selected).toBe(owner);
            deleteSessionEntryRows(selected, siblingScope.sessionKey, { deleteOwnedWindows: true });
          }, database),
      ];
      for (const mutate of mutations) {
        await sibling.read(authority);
        mutate();
        expect(actor.snapshot(authority)).toEqual(retained);
        expect(sibling.snapshot(authority)).toBeUndefined();
      }
      expect(readExactSessionEntryRow(owner, siblingScope.sessionKey)).toBeUndefined();
      expect(actor.snapshot(authority)?.entry?.sessionId).toBe("native-session");
    } finally {
      await sibling.release();
      await actor.release();
    }
  });
});

it("invalidates another logical session when both hold the same physical transcript window", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const { actor, scope } = await nativeSession(env);
    try {
      await actor.read(authority);
      replaceSessionEntrySync(
        { ...scope, sessionKey: "agent:main:dashboard:incognito-shared-window" },
        { sessionId: "native-session", updatedAt: 2, incognito: true },
      );
      expect(actor.snapshot(authority)).toBeUndefined();
    } finally {
      await actor.release();
    }
  });
});
