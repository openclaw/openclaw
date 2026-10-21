import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import * as sessionEntryReads from "../config/sessions/session-entry-read-runtime.js";
import { sessionChanges, type SessionRowFacts } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db-lifecycle.js";
import { revokeAgentDatabaseResources } from "../state/openclaw-agent-db-resources.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  createGatewayWorkerDispatchAdmission,
  withGatewayWorkerSessionAdmission,
} from "./server-worker-placement-dispatch-admission.js";
import { commitPreparedSessionWorkspace } from "./session-lifecycle-preparation.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
});

async function makeSession(sessionId: string) {
  const identity = { agentId: "main", sessionKey: `agent:main:${sessionId}`, sessionId };
  const storePath = path.join(tempDirs.make(`worker-${sessionId}-`), "sessions.sqlite");
  const entry = { sessionId, lifecycleRevision: "original", updatedAt: 1 };
  const scope = { ...identity, storePath };
  await replaceSessionEntry(scope, entry);
  const target = {
    ...scope,
    canonicalKey: identity.sessionKey,
    storeKeys: [identity.sessionKey],
    store: { [identity.sessionKey]: entry },
  };
  return { identity, entry, scope, target };
}

it("binds a workspace while retaining an admitted canonical session reader", async () => {
  const { identity, scope, target } = await makeSession("workspace");
  // A warm native reader is retained by worker admission across workspace preparation.
  expect(loadSessionEntry(scope)?.sessionId).toBe(identity.sessionId);
  const sessionRoot = path.join(tempDirs.make("worker-root-"), identity.sessionId);
  await withGatewayWorkerSessionAdmission({ identity, target }, async (source) => {
    const bound = await commitPreparedSessionWorkspace({
      prepared: { sessionRoot, spawnedCwd: sessionRoot },
      target: { ...source.target, sessionKey: identity.sessionKey },
      assertCurrent: source.assertCurrent,
      assertEntry: (current) => expect(current.sessionId).toBe(identity.sessionId),
      onCommitted: source.onCommitted,
      missingSessionMessage: "Session disappeared before workspace binding",
    });
    expect(bound.sessionRoot).toBe(sessionRoot);
    expect(source.assertCurrent().sessionId).toBe(identity.sessionId);
  });
  expect(loadSessionEntry(scope)).toMatchObject({ sessionRoot, spawnedCwd: sessionRoot });
});

it.each(["replacement", "database-close"] as const)(
  "revokes dispatch authority after %s without releasing unsettled custody",
  async (change) => {
    const { identity, scope, entry, target } = await makeSession("custody");
    const admit = createGatewayWorkerDispatchAdmission(async () => ({
      managedWorktrees: { findLiveByOwner: async () => undefined },
      resolveGatewaySessionStoreTargetInWorker: async () => target,
      resolveCanonicalSessionEntryFromStoreKeys: () => entry,
    }));
    const entered = createDeferredCore<AbortSignal>();
    const finish = createDeferredCore();
    const committed = vi.fn();
    let assertSessionCurrent: (() => void) | undefined;
    const operation = admit(identity, async (signal, assertCurrent) => {
      if (!signal || !assertCurrent) {
        entered.reject(new Error("Dispatch lacks retained session authority"));
        throw new Error("Dispatch lacks retained session authority");
      }
      assertSessionCurrent = assertCurrent;
      assertCurrent();
      entered.resolve(signal);
      await finish.promise;
      assertCurrent();
      committed();
    }).catch((error: unknown) => {
      entered.reject(error);
      return error;
    });
    let closing: Promise<void> | undefined;
    try {
      const signal = await entered.promise;
      if (change === "replacement") {
        await replaceSessionEntry(scope, { ...entry, lifecycleRevision: "new" });
      } else {
        closing = Promise.all(revokeAgentDatabaseResources({ path: scope.storePath })).then(
          () => undefined,
        );
        let closed = false;
        void closing.then(() => {
          closed = true;
        });
        // Cross the close owner's scheduling boundary, not a timer or polling loop.
        await Promise.resolve();
        expect(closed).toBe(false);
      }
      expect(signal.aborted).toBe(true);
      expect(() => assertSessionCurrent!()).toThrow();
      finish.resolve();
      expect(await operation).toBeInstanceOf(Error);
      expect(committed).not.toHaveBeenCalled();
      await closing;
      expect(() => assertSessionCurrent!()).toThrow("released");
    } finally {
      finish.resolve();
      await operation;
      await closing;
    }
  },
);

it.each([
  ["displayName", true],
  ["participants", true],
  ["transcript", true],
  ["unknown", false],
  ["lifecycleRevision", false],
  ["deviceFolder", false],
  ["replacement-before-read", false],
  ["partial-participants", true],
  ["unknown-participants", false],
  ["retained-participants", false],
  ["owner-generation", false],
  ["category-generation", false],
  ["member-generation", false],
] as const)(
  "reconciles a %s publication during worker source acquisition",
  async (field, accepted) => {
    const { identity, scope, target } = await makeSession("acquiring");
    const publish = (facts: SessionRowFacts) =>
      sessionChanges.emit({ ...scope, scope: "session-entry", facts });
    const originalRead = sessionEntryReads.withSessionEntryReadOnlyInWorker;
    using read = vi.spyOn(sessionEntryReads, "withSessionEntryReadOnlyInWorker");
    read.mockImplementationOnce(async (input, assertCurrent, consume, ...rest) => {
      if (field === "replacement-before-read") {
        await patchSessionEntryCore(scope, () => ({ lifecycleRevision: "replacement" }));
      }
      return originalRead(
        input,
        assertCurrent,
        async (result, owner) => {
          // The UI can publish metadata while dispatch is acquiring its exact row.
          if (field.endsWith("-participants")) {
            publish({
              kind: "participants",
              ...(field !== "unknown-participants" ? { projection: { participantCount: 1 } } : {}),
            });
          } else if (field.endsWith("-generation")) {
            publish(
              field === "owner-generation"
                ? {
                    kind: "owner",
                    sessionId: scope.sessionId,
                    lifecycleRevision: "replacement",
                    owner: undefined,
                  }
                : field === "category-generation"
                  ? { kind: "category", sessionId: "replacement", category: null }
                  : { kind: "member", sessionId: "replacement", identityId: "user", present: true },
            );
          } else if (field === "transcript" || field === "unknown") {
            sessionChanges.emit({
              ...scope,
              scope: field === "transcript" ? "transcript" : "session-entry",
              ...(field === "transcript"
                ? { facts: { kind: "unchanged" as const } }
                : { factsInvalidated: true as const }),
            });
          } else if (field !== "replacement-before-read") {
            await patchSessionEntryCore(scope, () =>
              field === "deviceFolder"
                ? { deviceFolder: { deviceId: "device", path: "/replacement" } }
                : field === "participants"
                  ? { participantCount: 1 }
                  : { [field]: "changed" },
            );
          }
          return consume(result, owner);
        },
        ...rest,
      );
    });
    const run = vi.fn(async (source: { assertCurrent: () => unknown }) => source.assertCurrent());
    const operation = withGatewayWorkerSessionAdmission(
      {
        identity,
        retainEntryFields:
          field === "retained-participants" ? ["participantCount"] : ["deviceFolder"],
        target,
      },
      run,
    );
    if (accepted) {
      await expect(operation).resolves.toMatchObject({ sessionId: identity.sessionId });
    } else {
      await expect(operation).rejects.toThrow("changed during admission");
    }
    expect(run).toHaveBeenCalledTimes(accepted ? 1 : 0);
  },
);
