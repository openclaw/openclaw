import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db-lifecycle.js";
import { revokeAgentDatabaseResources } from "../state/openclaw-agent-db-resources.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { createGatewayWorkerDispatchAdmission } from "./server-worker-placement-dispatch-admission.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
});

it.each(["replacement", "database-close"] as const)(
  "revokes dispatch authority after %s without releasing unsettled custody",
  async (change) => {
    const identity = { agentId: "main", sessionKey: "agent:main:custody", sessionId: "custody" };
    const storePath = path.join(tempDirs.make("worker-custody-"), "sessions.sqlite");
    const entry = { sessionId: identity.sessionId, lifecycleRevision: "original", updatedAt: 1 };
    await replaceSessionEntry({ ...identity, storePath }, entry);
    const target = {
      ...identity,
      storePath,
      canonicalKey: identity.sessionKey,
      storeKeys: [identity.sessionKey],
      store: { [identity.sessionKey]: entry },
    };
    const admit = createGatewayWorkerDispatchAdmission(async () => ({
      managedWorktrees: { findLiveByOwner: async () => undefined },
      resolveGatewaySessionStoreTargetWithStore: () => target,
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
        await replaceSessionEntry(
          { ...identity, storePath },
          { ...entry, lifecycleRevision: "new" },
        );
      } else {
        closing = Promise.all(revokeAgentDatabaseResources({ path: storePath })).then(
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
