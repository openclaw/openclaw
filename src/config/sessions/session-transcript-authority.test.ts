import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { useSqliteWorkerFault } from "../../../test/helpers/sqlite-worker-fault.js";
import * as metadataRuntime from "../../agents/sessions/session-manager-metadata-runtime.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import {
  onSessionIdentityMutation,
  type SessionIdentityMutation,
} from "../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { emitUserProfilesChanged } from "../../state/user-profile-events.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readPreparedSessionEntryChange } from "./session-accessor.sqlite-entry-cache-publication-state.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import {
  readPreparedSessionTranscriptChange,
  publishUnchangedSessionTranscriptAuthority,
  type SessionTranscriptAuthority,
} from "./session-transcript-authority.js";

const rollbackFault = useSqliteWorkerFault([
  {
    name: "authority_deferred_commit_failure",
    match: /^insert into transcript_events\b/iu,
    sql: `
    CREATE TEMP TABLE IF NOT EXISTS authority_rollback_parent (id INTEGER PRIMARY KEY);
    CREATE TEMP TABLE IF NOT EXISTS authority_rollback_child (
      id INTEGER REFERENCES authority_rollback_parent(id) DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TEMP TRIGGER authority_deferred_commit_failure AFTER INSERT ON main.transcript_events
    WHEN NEW.session_id = 'authority-commit-rollback'
    BEGIN INSERT INTO authority_rollback_child VALUES (1); END;
  `,
  },
]);

const releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0)) {
    release();
  }
  vi.restoreAllMocks();
});

function observe(sessionKey: string) {
  const values: SessionTranscriptAuthority[] = [];
  releases.push(
    sessionChanges.subscribeFacts((change) => {
      if (!("sessionKey" in change) || change.sessionKey !== sessionKey) {
        return;
      }
      const fact = readPreparedSessionTranscriptChange(change);
      if (fact?.kind === "postimage") {
        values.push(fact.value);
      }
    }),
  );
  return values;
}

it.each(["native", "worker"] as const)(
  "publishes the committed context through SessionManager %s persistence before completion",
  async (realm) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const scope = {
        agentId: "main",
        sessionKey: `agent:main:authority-${realm}`,
        sessionId: `authority-${realm}`,
        storePath: database.path,
        env: state.env,
      };
      replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const manager =
        realm === "native" ? SessionManager.open(scope) : await SessionManager.openAsync(scope);
      const values = observe(scope.sessionKey);
      const invoke = async (native: () => unknown, worker: () => Promise<unknown>) => {
        const count = values.length;
        if (realm === "native") {
          native();
          expect(values.length).toBeGreaterThan(count);
        } else {
          await worker();
          expect(values.length).toBeGreaterThan(count);
        }
        expect(values.at(-1)).toMatchObject({
          ...readTranscriptContextVersionInTransaction(database, scope.sessionId),
          sessionId: scope.sessionId,
          sessionKey: scope.sessionKey,
        });
      };
      await invoke(
        () => manager.appendMessage({ role: "user", content: "seed", timestamp: 1 }),
        () => manager.appendMessageAsync({ role: "user", content: "seed", timestamp: 1 }),
      );
      const seed = manager.getLeafId()!;
      await invoke(
        () =>
          manager.appendMessageWithTranscriptAnchor({
            role: "user",
            content: "second",
            timestamp: 2,
          }),
        () =>
          manager.appendMessageWithTranscriptAnchorAsync({
            role: "user",
            content: "second",
            timestamp: 2,
          }),
      );
      await invoke(
        () => manager.appendCustomEntry("authority", { synthetic: true }),
        () => manager.appendCustomEntryAsync("authority", { synthetic: true }),
      );
      await invoke(
        () => manager.appendSessionInfo("authority"),
        () => manager.appendSessionInfoAsync("authority"),
      );
      await invoke(
        () => manager.appendCustomMessageEntry("notice", "synthetic", true),
        () => manager.appendCustomMessageEntryAsync("notice", "synthetic", true),
      );
      await invoke(
        () => manager.appendLabelChange(seed, "selected"),
        () => manager.appendLabelChangeAsync(seed, "selected"),
      );
      await invoke(
        () => manager.appendCompaction("summary", seed, 12),
        () => manager.appendCompactionAsync("summary", seed, 12),
      );
      await invoke(
        () => manager.appendResetBoundary("reset", seed),
        () => manager.appendResetBoundaryAsync("reset", seed),
      );
      await invoke(
        () => manager.appendLeafControl({ targetId: seed, appendParentId: seed }),
        () => manager.appendLeafControlAsync({ targetId: seed, appendParentId: seed }),
      );
      await invoke(
        () => manager.branchWithSummary(seed, "branch"),
        () => manager.branchWithSummaryAsync(seed, "branch"),
      );
      await invoke(
        () => manager.removeTrailingEntries((entry) => entry.type === "branch_summary"),
        () => manager.removeTrailingEntriesAsync((entry) => entry.type === "branch_summary"),
      );
      const raw = {
        type: "custom" as const,
        id: `raw-${realm}`,
        parentId: manager.getLeafId(),
        timestamp: new Date(1).toISOString(),
        customType: "raw-authority",
      };
      await invoke(
        () => manager.persist(raw),
        () => manager.persistAsync(raw),
      );
      await invoke(
        () =>
          SessionManager.appendMessageToTranscript(scope, {
            role: "user",
            content: "static",
            timestamp: 3,
          }),
        () =>
          SessionManager.appendMessageToTranscriptAsync(scope, {
            role: "user",
            content: "static",
            timestamp: 3,
          }),
      );
      const refreshed =
        realm === "native" ? SessionManager.open(scope) : await SessionManager.openAsync(scope);
      const populateRewrite = (rewriter: SessionManager) => {
        rewriter.resetLeaf();
        const ids = new Map<string, string>();
        for (const entry of refreshed.getEntries()) {
          if (entry.type === "message" && entry.message.role === "user") {
            ids.set(entry.id, rewriter.appendMessage(entry.message));
          }
        }
        return ids;
      };
      await invoke(
        () => {
          const rewrite = refreshed.prepareTranscriptRewrite();
          rewrite.commit(populateRewrite(rewrite.sessionManager));
        },
        async () => {
          const rewrite = await refreshed.prepareTranscriptRewriteAsync();
          await rewrite.commit(populateRewrite(rewrite.sessionManager));
        },
      );
    });
  },
);

it("installs final transcript facts before entry observers and discards nested rollback contributions", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:authority-rollback",
      sessionId: "authority-rollback",
      storePath: database.path,
      env: state.env,
    };
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const manager = SessionManager.open(scope);
    manager.appendMessage({ role: "user", content: "seed", timestamp: 1 });
    const before = readTranscriptContextVersionInTransaction(database, scope.sessionId);
    const values = observe(scope.sessionKey);
    let observed = false;
    releases.push(
      sessionChanges.subscribe((change) => {
        if (!("sessionKey" in change) || change.sessionKey !== scope.sessionKey) {
          return;
        }
        observed = true;
        expect(values.at(-1)).toMatchObject(
          readTranscriptContextVersionInTransaction(database, scope.sessionId),
        );
        throw new Error("Synthetic public observer failure");
      }),
    );
    const options = { agentId: scope.agentId, path: database.path, env: state.env };
    runOpenClawAgentWriteTransaction(() => {
      replaceSessionEntrySync(scope, {
        sessionId: scope.sessionId,
        updatedAt: 2,
        label: "changed",
      });
      manager.appendCustomEntry("retained");
      expect(() =>
        runOpenClawAgentWriteTransaction(() => {
          manager.appendCustomEntry("rolled-back");
          throw new Error("Synthetic rollback");
        }, options),
      ).toThrow("Synthetic rollback");
      expect(values).toEqual([]);
    }, options);
    expect(observed).toBe(true);
    expect(values).toHaveLength(1);
    expect(values[0]?.rawSeq).toBe((before.rawSeq ?? -1) + 1);
    values.length = 0;
    expect(() =>
      runOpenClawAgentWriteTransaction(() => {
        manager.appendCustomEntry("outer-rollback");
        throw new Error("Outer rollback");
      }, options),
    ).toThrow("Outer rollback");
    expect(values).toEqual([]);
  });
});

it("does not publish a tentative typed write inside an unmanaged raw outer transaction", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:authority-raw-outer",
      sessionId: "authority-raw-outer",
      storePath: database.path,
      env: state.env,
    };
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const manager = SessionManager.open(scope);
    manager.appendMessage({ role: "user", content: "seed", timestamp: 1 });
    const before = readTranscriptContextVersionInTransaction(database, scope.sessionId);
    const values = observe(scope.sessionKey);
    database.db.exec("BEGIN IMMEDIATE");
    try {
      manager.appendCustomEntry("uncommitted");
      expect(values).toEqual([]);
    } finally {
      database.db.exec("ROLLBACK");
    }
    expect(values).toEqual([]);
    expect(readTranscriptContextVersionInTransaction(database, scope.sessionId)).toEqual(before);
  });
});

it("publishes worker initialization and branched entry metadata with the transcript before observers", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:authority-companion",
      sessionId: "authority-companion",
      storePath: database.path,
      env: state.env,
    };
    const manager = await SessionManager.openAsync(scope);
    const contexts = observe(scope.sessionKey);
    const identities: SessionIdentityMutation[] = [];
    releases.push(
      onSessionIdentityMutation((mutation) => {
        if ("current" in mutation && mutation.current.sessionKeys.includes(scope.sessionKey)) {
          identities.push(mutation);
          if (mutation.kind === "replace") {
            expect(contexts.at(-1)?.sessionId).toBe(mutation.current.sessionId);
          }
        }
      }),
    );
    let entry: ReturnType<typeof readPreparedSessionEntryChange>;
    releases.push(
      sessionChanges.subscribeFacts((change) => {
        if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
          entry = readPreparedSessionEntryChange(change, scope.sessionKey) ?? entry;
        }
      }),
    );
    const seed = await manager.appendMessageAsync({ role: "user", content: "seed", timestamp: 1 });
    expect(entry?.entry?.sessionId).toBe(scope.sessionId);
    let observedBranch = false;
    releases.push(
      sessionChanges.subscribe((change) => {
        if (
          !("sessionKey" in change) ||
          change.sessionKey !== scope.sessionKey ||
          entry?.entry?.sessionId === scope.sessionId
        ) {
          return;
        }
        observedBranch = true;
        expect(contexts.at(-1)?.sessionId).toBe(entry?.entry?.sessionId);
      }),
    );
    await manager.createBranchedSession(seed!);
    expect(observedBranch).toBe(true);
    expect(entry?.entry?.sessionId).toBe(manager.getSessionId());
    expect(entry?.entry?.sessionId).not.toBe(scope.sessionId);
    expect(identities.map((mutation) => mutation.kind)).toEqual(["create", "replace"]);
  });
});

it("keeps a delayed worker mutation postimage after native content-preserving publication and profile notification", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:authority-delayed",
      sessionId: "authority-delayed",
      storePath: database.path,
      env: state.env,
    };
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const manager = await SessionManager.openAsync(scope);
    await manager.appendMessageAsync({ role: "user", content: "seed", timestamp: 1 });
    const values = observe(scope.sessionKey);
    let interposed = false;
    const observeCommit = workerAdmission.observeSqliteWorkerCommittedFacts;
    vi.spyOn(workerAdmission, "observeSqliteWorkerCommittedFacts").mockImplementation(
      (admission, install) => {
        observeCommit(admission, (receipt) => {
          if (
            !interposed &&
            isRecord(receipt.facts) &&
            receipt.facts.kind === "session-manager-authority"
          ) {
            interposed = true;
            // The real worker has committed; delay only host delivery while the native owner
            // publishes the same unchanged-content fact used by cold materialization/reconcile.
            runOpenClawAgentWriteTransaction(
              (current) => {
                publishUnchangedSessionTranscriptAuthority(current, scope.sessionKey);
              },
              { agentId: scope.agentId, path: database.path, env: state.env },
            );
            emitUserProfilesChanged();
          }
          install(receipt);
        });
      },
    );
    await manager.appendCustomEntryAsync("delayed-authority");
    expect(interposed).toBe(true);
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject(
      readTranscriptContextVersionInTransaction(database, scope.sessionId),
    );
  });
});

it("publishes the committed branch identity when its ordinary reply is lost", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:authority-lost-reply",
      sessionId: "authority-lost-reply",
      storePath: database.path,
      env: state.env,
    };
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const manager = await SessionManager.openAsync(scope);
    const seed = await manager.appendMessageAsync({ role: "user", content: "seed", timestamp: 1 });
    const identities: SessionIdentityMutation[] = [];
    const originalTarget = manager.getSessionTarget();
    const observedManagers: unknown[] = [];
    releases.push(
      onSessionIdentityMutation((mutation) => {
        if ("current" in mutation && mutation.current.sessionKeys.includes(scope.sessionKey)) {
          identities.push(mutation);
          observedManagers.push({
            sessionId: manager.getSessionId(),
            target: manager.getSessionTarget(),
          });
        }
      }),
    );
    const runMetadata = metadataRuntime.withSessionMetadataWorker;
    vi.spyOn(metadataRuntime, "withSessionMetadataWorker").mockImplementation(
      (options, owner, assertCurrent, operation, controls) =>
        runMetadata(
          options,
          owner,
          assertCurrent,
          (worker) =>
            operation({
              async execute(command, executeOptions) {
                const value = await worker.execute(command, executeOptions);
                if (command.type === "session.transcript.branch") {
                  throw new Error("Synthetic ordinary reply loss after native COMMIT");
                }
                return value;
              },
            }),
          controls,
        ),
    );
    await expect(manager.createBranchedSession(seed!)).rejects.toThrow(
      "Synthetic ordinary reply loss after native COMMIT",
    );
    const stored = readExactSessionEntryRow(database, scope.sessionKey)?.entry;
    expect(stored?.sessionId).not.toBe(scope.sessionId);
    expect(identities).toMatchObject([
      {
        kind: "replace",
        previous: { sessionId: scope.sessionId },
        current: { sessionId: stored?.sessionId },
      },
    ]);
    expect(identities).toHaveLength(1);
    expect(observedManagers).toEqual([
      {
        sessionId: stored?.sessionId,
        target: { ...originalTarget, sessionId: stored?.sessionId },
      },
    ]);
  });
});
it("keeps captured context current after a granted worker append rolls back at COMMIT", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:authority-commit-rollback",
      sessionId: "authority-commit-rollback",
      storePath: database.path,
      env: state.env,
    };
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const manager = await SessionManager.openAsync(scope);
    await manager.appendMessageAsync({ role: "user", content: "seed", timestamp: 1 });
    const before = readTranscriptContextVersionInTransaction(database, scope.sessionId);
    rollbackFault.enable();
    let commitGranted = false;
    let native: workerAdmission.SqliteWorkerOperationAdmission | undefined;
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (authorize, attachment) =>
        createAdmission(
          (request, grant) =>
            authorize(request, (beforeRelease) => {
              const granted = grant(beforeRelease);
              if (
                granted &&
                request.stage === "commit" &&
                isRecord(request.facts) &&
                request.facts.kind === "session-manager-authority"
              ) {
                commitGranted = true;
              }
              return granted;
            }),
          attachment,
        ),
    );
    const observeCommit = workerAdmission.observeSqliteWorkerCommittedFacts;
    vi.spyOn(workerAdmission, "observeSqliteWorkerCommittedFacts").mockImplementation(
      (admission, install) => {
        native = admission;
        observeCommit(admission, install);
      },
    );
    await expect(
      SessionManager.readSessionContextAsync(scope, async () => {
        await expect(manager.appendCustomEntryAsync("must-rollback")).rejects.toThrow(
          /FOREIGN KEY constraint failed/i,
        );
        expect(commitGranted).toBe(true);
        expect(native?.committed).toBeUndefined();
        expect(native?.settlement?.kind).toBe("completed");
        expect(readTranscriptContextVersionInTransaction(database, scope.sessionId)).toEqual(
          before,
        );
        return "still-current";
      }),
    ).resolves.toBe("still-current");
  });
});
