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
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";
import {
  readTranscriptContextVersionInTransaction as readVersion,
  touchTranscriptMutationInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import { replaceSqliteTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import {
  readPreparedSessionTranscriptChange,
  readFinalSessionTranscriptProjection,
  publishUnchangedSessionTranscriptAuthority,
} from "./session-transcript-authority.js";
import type { SessionTranscriptAuthority } from "./session-transcript-authority.types.js";
import { withTranscriptDatabase } from "./session-transcript-fixture.test-support.js";
import { markSessionTranscriptIndexDirtyInTransaction } from "./session-transcript-index.js";

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

function observe(sessionKey: string, projection = false) {
  const values: SessionTranscriptAuthority[] = [];
  listen(
    sessionKey,
    (change) => {
      const fact = readPreparedSessionTranscriptChange(change);
      const value = projection
        ? readFinalSessionTranscriptProjection(change)
        : fact?.kind === "postimage"
          ? fact.value
          : undefined;
      if (value) {
        values.push(value);
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
    const values = observe(scope.sessionKey);
    const ready = observe(scope.sessionKey, true);
    const seed =
      realm === "native"
        ? manager.appendMessage(message("seed"))
        : await manager.appendMessageAsync(message("seed"));
    expect(values.at(-1)).toMatchObject({
      ...readVersion(fixture.database, scope.sessionId),
      sessionId: scope.sessionId,
      sessionKey: scope.sessionKey,
      lastMessagePreview: "seed",
    });
    expect(ready.at(-1)).toMatchObject({ sessionId: scope.sessionId, projectionReady: true });
    return run({ ...fixture, manager, seed });
  });
}
const withNativeSeeded = (label: string, run: Parameters<typeof withSeeded>[1]) =>
  withSeeded(label, run, "native");

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

it("publishes committed facts before observers and discards managed and raw rollbacks", () =>
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
    expect(values.at(-1)?.lastMessagePreview).toBeUndefined();
    values.length = 0;
    rollback("outer-rollback", "Outer rollback");
    expect(values).toEqual([]);
    const committed = readVersion(database, scope.sessionId);
    database.db.exec("BEGIN IMMEDIATE");
    try {
      manager.appendCustomEntry("uncommitted");
      expect(values).toEqual([]);
    } finally {
      database.db.exec("ROLLBACK");
    }
    expect(values).toEqual([]);
    expect(readVersion(database, scope.sessionId)).toEqual(committed);
  }));

it.each([false, true])(
  "publishes initialization and branch identity before observers (lost reply=%s)",
  (lostReply) =>
    withTranscriptDatabase(`authority-branch-${lostReply}`, async ({ database, scope }) => {
      const manager = await SessionManager.openAsync(scope);
      const contexts = observe(scope.sessionKey);
      const observedManagers: unknown[] = [];
      const identities = observeIdentities(scope.sessionKey, (mutation) => {
        if (mutation.kind === "replace") {
          expect(contexts.at(-1)?.sessionId).toBe(mutation.current.sessionId);
          observedManagers.push([manager.getSessionId(), manager.getSessionTarget()?.sessionId]);
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
      if (lostReply) {
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
      }
      const branch = manager.createBranchedSession(seed!);
      if (lostReply) {
        await expect(branch).rejects.toThrow("Synthetic ordinary reply loss after native COMMIT");
      } else {
        await branch;
      }
      const stored = readExactSessionEntryRow(database, scope.sessionKey)?.entry;
      expect(observedBranch).toBe(true);
      expect(entry?.entry?.sessionId).toBe(manager.getSessionId());
      expect(stored?.sessionId).not.toBe(scope.sessionId);
      expect(identities).toMatchObject([
        { kind: "create" },
        {
          kind: "replace",
          previous: { sessionId: scope.sessionId },
          current: { sessionId: stored?.sessionId },
        },
      ]);
      expect(observedManagers).toEqual([[stored?.sessionId, stored?.sessionId]]);
    }),
);

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
    expect(values.at(-1)?.lastMessagePreview).toBeUndefined();
  }));

it("keeps captured context current after a worker append rolls back at COMMIT", () =>
  withSeeded("commit-rollback", async ({ database, scope, manager }) => {
    const before = readVersion(database, scope.sessionId);
    rollbackFault.enable();
    await expect(
      SessionManager.readSessionContextAsync(scope, async () => {
        await expect(manager.appendCustomEntryAsync("must-rollback")).rejects.toThrow(
          /FOREIGN KEY constraint failed/i,
        );
        expect(readVersion(database, scope.sessionId)).toEqual(before);
        return "still-current";
      }),
    ).resolves.toBe("still-current");
  }));

it.each(["ready", "dirty", "rollback"] as const)(
  "publishes only final committed projection readiness: %s",
  (outcome) =>
    withNativeSeeded(`projection-${outcome}`, async ({ database, scope, state }) => {
      const ready = observe(scope.sessionKey, true);
      const events = loadTranscriptEventsFromDatabase(database, scope.sessionId);
      const write = () =>
        writeTransaction(
          (current) => {
            replaceSqliteTranscriptEventsInTransaction(
              current,
              resolveSqliteTranscriptScope(scope),
              events,
            );
            if (outcome === "dirty") {
              markSessionTranscriptIndexDirtyInTransaction(current.db, scope.sessionId);
              touchTranscriptMutationInTransaction(current, scope.sessionId);
            }
            if (outcome === "rollback") {
              throw new Error("Synthetic projection rollback");
            }
            expect(ready).toEqual([]);
          },
          { agentId: scope.agentId, path: database.path, env: state.env },
        );
      if (outcome === "rollback") {
        expect(write).toThrow("Synthetic projection rollback");
      } else {
        write();
      }
      expect(ready).toMatchObject(
        outcome === "ready" ? [{ sessionId: scope.sessionId, projectionReady: true }] : [],
      );
    }),
);
