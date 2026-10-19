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
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import { runOpenClawAgentWriteTransaction as writeTransaction } from "../../state/openclaw-agent-db.js";
import { emitUserProfilesChanged } from "../../state/user-profile-events.js";
import { readPreparedSessionEntryChange } from "./session-accessor.sqlite-entry-cache-publication-state.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { readTranscriptContextVersionInTransaction as readVersion } from "./session-accessor.sqlite-transcript-state.js";
import {
  readPreparedSessionTranscriptChange,
  publishUnchangedSessionTranscriptAuthority,
} from "./session-transcript-authority.js";
import type { SessionTranscriptAuthority } from "./session-transcript-authority.types.js";
import { withTranscriptDatabase } from "./session-transcript-fixture.test-support.js";

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

function listen(sessionKey: string, run: (change: SessionRowChange) => void, facts = false) {
  const listener = (change: SessionRowChange) => {
    if ("sessionKey" in change && change.sessionKey === sessionKey) {
      run(change);
    }
  };
  releases.push(
    facts ? sessionChanges.subscribeFacts(listener) : sessionChanges.subscribe(listener),
  );
}

function observe(sessionKey: string) {
  const values: SessionTranscriptAuthority[] = [];
  listen(
    sessionKey,
    (change) => {
      const fact = readPreparedSessionTranscriptChange(change);
      if (fact?.kind === "postimage") {
        values.push(fact.value);
      }
    },
    true,
  );
  return values;
}

function observeIdentities(sessionKey: string, run: (mutation: SessionIdentityMutation) => void) {
  const identities: SessionIdentityMutation[] = [];
  releases.push(
    onSessionIdentityMutation((mutation) => {
      if ("current" in mutation && mutation.current.sessionKeys.includes(sessionKey)) {
        identities.push(mutation);
        run(mutation);
      }
    }),
  );
  return identities;
}

const message = (content: string, timestamp = 1) => ({ role: "user" as const, content, timestamp });
type Fixture = Parameters<Parameters<typeof withTranscriptDatabase>[1]>[0];
function withSeeded(
  label: string,
  run: (fixture: Fixture & { manager: SessionManager; seed: string | undefined }) => Promise<void>,
  realm: "native" | "worker" = "worker",
) {
  return withTranscriptDatabase(`authority-${label}`, async (fixture) => {
    const { scope } = fixture;
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const manager =
      realm === "native" ? SessionManager.open(scope) : await SessionManager.openAsync(scope);
    const seed =
      realm === "native"
        ? manager.appendMessage(message("seed"))
        : await manager.appendMessageAsync(message("seed"));
    return run({ ...fixture, manager, seed });
  });
}
const withNativeSeeded = (label: string, run: Parameters<typeof withSeeded>[1]) =>
  withSeeded(label, run, "native");

it.each(["native", "worker"] as const)(
  "publishes the committed context through SessionManager %s persistence before completion",
  (realm) =>
    withTranscriptDatabase(`authority-${realm}`, async ({ database, scope }) => {
      replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const manager =
        realm === "native" ? SessionManager.open(scope) : await SessionManager.openAsync(scope);
      const writer =
        realm === "native"
          ? manager
          : {
              appendMessage: manager.appendMessageAsync.bind(manager),
              appendMessageWithTranscriptAnchor:
                manager.appendMessageWithTranscriptAnchorAsync.bind(manager),
              appendCustomEntry: manager.appendCustomEntryAsync.bind(manager),
              appendSessionInfo: manager.appendSessionInfoAsync.bind(manager),
              appendCustomMessageEntry: manager.appendCustomMessageEntryAsync.bind(manager),
              appendLabelChange: manager.appendLabelChangeAsync.bind(manager),
              appendCompaction: manager.appendCompactionAsync.bind(manager),
              appendResetBoundary: manager.appendResetBoundaryAsync.bind(manager),
              appendLeafControl: manager.appendLeafControlAsync.bind(manager),
              branchWithSummary: manager.branchWithSummaryAsync.bind(manager),
              removeTrailingEntries: manager.removeTrailingEntriesAsync.bind(manager),
              persist: manager.persistAsync.bind(manager),
            };
      const values = observe(scope.sessionKey);
      const invoke = async (write: () => unknown, lastMessagePreview?: string | null) => {
        const count = values.length;
        const result = write();
        if (realm === "worker") {
          await result;
        }
        expect(values.length).toBeGreaterThan(count);
        expect(values.at(-1)).toMatchObject({
          ...readVersion(database, scope.sessionId),
          sessionId: scope.sessionId,
          sessionKey: scope.sessionKey,
        });
        expect(values.at(-1)?.lastMessagePreview).toBe(lastMessagePreview);
      };
      await invoke(() => writer.appendMessage(message("seed", 1)), "seed");
      const seed = manager.getLeafId()!;
      await invoke(() => writer.appendMessageWithTranscriptAnchor(message("second", 2)), "second");
      await invoke(() => writer.appendCustomEntry("authority", { synthetic: true }));
      await invoke(() => writer.appendSessionInfo("authority"));
      await invoke(() => writer.appendCustomMessageEntry("notice", "synthetic", true));
      await invoke(() => writer.appendLabelChange(seed, "selected"));
      await invoke(() => writer.appendCompaction("summary", seed, 12));
      await invoke(() => writer.appendResetBoundary("reset", seed));
      await invoke(() => writer.appendLeafControl({ targetId: seed, appendParentId: seed }));
      await invoke(() => writer.branchWithSummary(seed, "branch"));
      await invoke(() => writer.removeTrailingEntries((entry) => entry.type === "branch_summary"));
      const raw = {
        type: "custom" as const,
        id: `raw-${realm}`,
        parentId: manager.getLeafId(),
        timestamp: new Date(1).toISOString(),
        customType: "raw-authority",
      };
      await invoke(() => writer.persist(raw));
      await invoke(() =>
        realm === "native"
          ? SessionManager.appendMessageToTranscript(scope, message("static", 3))
          : SessionManager.appendMessageToTranscriptAsync(scope, message("static", 3)),
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
      await invoke(() => {
        if (realm === "native") {
          const rewrite = refreshed.prepareTranscriptRewrite();
          return rewrite.commit(populateRewrite(rewrite.sessionManager));
        }
        return refreshed
          .prepareTranscriptRewriteAsync()
          .then((rewrite) => rewrite.commit(populateRewrite(rewrite.sessionManager)));
      });
    }),
);

it("publishes bounded worker previews and clears them for nonprojectable and side appends", () =>
  withTranscriptDatabase("authority-preview", async ({ scope }) => {
    const manager = await SessionManager.openAsync(scope);
    const values = observe(scope.sessionKey);
    const entry = (id: string, parentId: string | null, content = "") => ({
      type: "message" as const,
      id,
      parentId,
      timestamp: new Date(1).toISOString(),
      message: message(content),
    });
    const atLimit = entry("at-preview-limit", manager.getLeafId());
    atLimit.message.content = "x".repeat(
      64 * 1024 - Buffer.byteLength(JSON.stringify(atLimit)) - 1,
    );
    await manager.persistAsync(atLimit);
    expect(values.at(-1)?.lastMessagePreview).toBe(`${"x".repeat(237)}...`);

    const overLimit = entry("over-preview-limit", atLimit.id);
    overLimit.message.content = "x".repeat(
      64 * 1024 - Buffer.byteLength(JSON.stringify(overLimit)),
    );
    await manager.persistAsync(overLimit);
    expect(values.at(-1)?.lastMessagePreview).toBeNull();

    const hidden = {
      ...entry("hidden-preview", overLimit.id),
      message: { ...atLimit.message, content: "hidden", display: false },
    };
    await manager.persistAsync(hidden);
    expect(values.at(-1)?.lastMessagePreview).toBeUndefined();

    await manager.persistAsync(entry("side-preview", atLimit.id, "side branch"));
    expect(values.at(-1)?.lastMessagePreview).toBeUndefined();
  }));

it("installs final transcript facts before entry observers and discards nested rollback contributions", () =>
  withNativeSeeded("rollback", async ({ database, scope, state, manager }) => {
    const before = readVersion(database, scope.sessionId);
    const values = observe(scope.sessionKey);
    let observed = false;
    listen(scope.sessionKey, () => {
      observed = true;
      expect(values.at(-1)).toMatchObject(readVersion(database, scope.sessionId));
      throw new Error("Synthetic public observer failure");
    });
    const options = { agentId: scope.agentId, path: database.path, env: state.env };
    const rollback = (label: string, error: string) => {
      expect(() =>
        writeTransaction(() => {
          manager.appendCustomEntry(label);
          throw new Error(error);
        }, options),
      ).toThrow(error);
    };
    writeTransaction(() => {
      replaceSessionEntrySync(scope, {
        sessionId: scope.sessionId,
        updatedAt: 2,
        label: "changed",
      });
      manager.appendCustomEntry("retained");
      rollback("rolled-back", "Synthetic rollback");
      expect(values).toEqual([]);
    }, options);
    expect(observed).toBe(true);
    expect(values).toMatchObject([{ rawSeq: (before.rawSeq ?? -1) + 1 }]);
    values.length = 0;
    rollback("outer-rollback", "Outer rollback");
    expect(values).toEqual([]);
  }));

it("does not publish a tentative typed write inside an unmanaged raw outer transaction", () =>
  withNativeSeeded("raw-outer", async ({ database, scope, manager }) => {
    const before = readVersion(database, scope.sessionId);
    const values = observe(scope.sessionKey);
    database.db.exec("BEGIN IMMEDIATE");
    try {
      manager.appendCustomEntry("uncommitted");
      expect(values).toEqual([]);
    } finally {
      database.db.exec("ROLLBACK");
    }
    expect(values).toEqual([]);
    expect(readVersion(database, scope.sessionId)).toEqual(before);
  }));

it("publishes worker initialization and branched entry metadata with the transcript before observers", () =>
  withTranscriptDatabase("authority-companion", async ({ scope }) => {
    const manager = await SessionManager.openAsync(scope);
    const contexts = observe(scope.sessionKey);
    const identities = observeIdentities(scope.sessionKey, (mutation) => {
      if (mutation.kind === "replace") {
        expect(contexts.at(-1)?.sessionId).toBe(mutation.current.sessionId);
      }
    });
    let entry: ReturnType<typeof readPreparedSessionEntryChange>;
    listen(
      scope.sessionKey,
      (change) => {
        entry = readPreparedSessionEntryChange(change, scope.sessionKey) ?? entry;
      },
      true,
    );
    const seed = await manager.appendMessageAsync(message("seed"));
    expect(entry?.entry?.sessionId).toBe(scope.sessionId);
    let observedBranch = false;
    listen(scope.sessionKey, () => {
      if (entry?.entry?.sessionId !== scope.sessionId) {
        observedBranch = true;
        expect(contexts.at(-1)?.sessionId).toBe(entry?.entry?.sessionId);
      }
    });
    await manager.createBranchedSession(seed!);
    expect(observedBranch).toBe(true);
    expect(entry?.entry?.sessionId).toBe(manager.getSessionId());
    expect(entry?.entry?.sessionId).not.toBe(scope.sessionId);
    expect(identities.map((mutation) => mutation.kind)).toEqual(["create", "replace"]);
  }));

it("keeps a delayed worker mutation postimage after native content-preserving publication and profile notification", () =>
  withSeeded("delayed", async ({ database, scope, state, manager }) => {
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
            writeTransaction(
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
    expect(values).toMatchObject([readVersion(database, scope.sessionId)]);
  }));

it("publishes the committed branch identity when its ordinary reply is lost", () =>
  withSeeded("lost-reply", async ({ database, scope, manager, seed }) => {
    const originalTarget = manager.getSessionTarget();
    const observedManagers: unknown[] = [];
    const identities = observeIdentities(scope.sessionKey, () => {
      observedManagers.push({
        sessionId: manager.getSessionId(),
        target: manager.getSessionTarget(),
      });
    });
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
    expect(observedManagers).toEqual([
      {
        sessionId: stored?.sessionId,
        target: { ...originalTarget, sessionId: stored?.sessionId },
      },
    ]);
  }));
it("keeps captured context current after a granted worker append rolls back at COMMIT", () =>
  withSeeded("commit-rollback", async ({ database, scope, manager }) => {
    const before = readVersion(database, scope.sessionId);
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
        expect(readVersion(database, scope.sessionId)).toEqual(before);
        return "still-current";
      }),
    ).resolves.toBe("still-current");
  }));
