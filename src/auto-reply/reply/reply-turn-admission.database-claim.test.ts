import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as sessionEntries from "../../config/sessions/session-accessor.sqlite-entry.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import * as registry from "../../sessions/session-controller.js";
import {
  runSessionMutation,
  startSessionControllerInterruption,
} from "../../sessions/session-controller.lifecycle.js";
import {
  acquireReplyOperationSessionActor,
  getReplyOperationSessionTarget,
} from "../../sessions/session-controller.session-reader.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import * as controllerWait from "../../sessions/session-controller.wait.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { admitReplyTurn } from "./reply-turn-admission.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    testing.resetSessionControllerForTest();
    await closeOpenClawAgentDatabasesAsync();
    memorySessionActorOwners.reset();
    vi.restoreAllMocks();
    cleanup();
  }),
);

const sessionKey = "global";
const sessionId = "original-session";
function admit(storePath: string, request: Partial<Parameters<typeof admitReplyTurn>[0]> = {}) {
  return admitReplyTurn({
    storePath,
    sessionKey,
    sessionId,
    kind: "visible",
    resetTriggered: false,
    ...request,
  });
}
function seed(storePath: string, id = sessionId) {
  sessionEntries.replaceSessionEntrySync(
    { storePath, sessionKey },
    { sessionId: id, updatedAt: 1 },
  );
}
function complete(result: Awaited<ReturnType<typeof admitReplyTurn>> | undefined) {
  if (result?.status === "owned") {
    result.operation.complete();
  }
}

it("keeps incognito admission and its actor with the existing memory owner", async ({ signal }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const key = "agent:main:dashboard:incognito-reply-admission";
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
    const database = { agentId: "main", path: storePath };
    const scope = { agentId: "main", storePath, sessionKey: key };
    await sessionEntries.replaceSessionEntry(scope, { sessionId, updatedAt: 1, incognito: true });
    const owner = memorySessionActorOwners.read(database);
    expect(owner).toBeDefined();
    const expectMemoryOwner = () => {
      expect(sessionEntries.loadSessionEntry(scope)).toMatchObject({ sessionId, updatedAt: 1 });
      expect(memorySessionActorOwners.read(database)).toBe(owner);
      expect(getOpenClawAgentDatabaseIfOpen(database)).toBeUndefined();
      expect(fs.existsSync(storePath)).toBe(false);
    };
    const result = await admit(storePath, { agentId: "main", sessionKey: key });
    try {
      assert(result.status === "owned" && result.databaseClaim);
      const { operation, databaseClaim } = result;
      expect(getReplyOperationSessionTarget(operation)).toMatchObject({
        agentId: "main",
        storePath,
        readSource: { ...database, databaseIdentity: owner?.identity.incarnation },
        target: { canonicalKey: key, storeKeys: [key] },
      });
      expect(databaseClaim).toMatchObject({
        kind: "memory",
        identity: owner?.identity.handle,
        incarnation: owner?.identity.incarnation,
      });
      const actor = await acquireReplyOperationSessionActor(operation);
      expect(actor?.target).toEqual({ database: owner?.identity, sessionKey: key });
      expectMemoryOwner();
      expect(sessionEntries.loadSessionEntry(scope)?.incognito).toBe(true);
      expect(databaseClaim.isCurrent()).toBe(true);
      operation.complete();
      expect(() => acquireReplyOperationSessionActor(operation)).toThrow();
      expect(() => getReplyOperationSessionTarget(operation)).toThrow();
      expect(
        await withinTest(controllerWait.waitForReplyRunSuccessorAdmission(key, null), signal),
      ).toMatchObject({ settled: true });
      expect(databaseClaim.isCurrent()).toBe(false);
      expectMemoryOwner();
    } finally {
      complete(result);
      await controllerWait.waitForReplyRunSuccessorAdmission(key, null);
    }
  });
});

it.each(["cancelled", "request-changed"] as const)(
  "does not admit a delayed healthy rotation after %s",
  async (change) => {
    const storePath = path.join(tempDirs.make("reply-delayed-rotation-"), "owner.sqlite");
    const nextSessionId = "after-compaction";
    seed(storePath);
    const owner = await admit(storePath);
    assert(owner.status === "owned" && owner.databaseClaim);
    const captured =
      createDeferred<Awaited<ReturnType<typeof sessionEntries.loadSessionEntryForAdmission>>>();
    const release = createDeferred();
    const load = sessionEntries.loadSessionEntryForAdmission;
    let reads = 0;
    vi.spyOn(sessionEntries, "loadSessionEntryForAdmission").mockImplementation(async (...args) => {
      const read = ++reads;
      const snapshot = await load(...args);
      if (read === 2) {
        captured.resolve(snapshot);
        await release.promise;
      }
      return snapshot;
    });
    const controller = new AbortController();
    let requestFailure: Error | undefined;
    const pending = admit(storePath, {
      expectedSessionId: sessionId,
      upstreamAbortSignal: controller.signal,
      assertRequestCurrent: () => {
        if (requestFailure) {
          throw requestFailure;
        }
      },
    });
    try {
      const snapshot = await awaitGateBeforeSettlement(
        captured.promise,
        pending,
        "Admission completed before its final snapshot was captured",
      );
      expect(snapshot.entry?.sessionId).toBe(sessionId);
      expect(snapshot.databaseClaim.isCurrent()).toBe(true);
      expect(snapshot.databaseClaim.identity).toBe(owner.databaseClaim.identity);
      await sessionEntries.replaceSessionEntry(
        { storePath, sessionKey },
        { sessionId: nextSessionId, updatedAt: 2 },
      );
      owner.operation.updateSessionId(nextSessionId);
      owner.operation.complete();
      if (change === "cancelled") {
        controller.abort();
      } else {
        requestFailure = new Error("Original caller was retired during preparation");
        await closeOpenClawAgentDatabaseByPathAsync(storePath);
      }
      release.resolve();
      if (change === "cancelled") {
        await expect(pending).resolves.toEqual({ status: "skipped", reason: "aborted" });
      } else {
        // Caller refusal keeps precedence over a concurrent physical-store retirement.
        await expect(pending).rejects.toBe(requestFailure);
      }
      expect(reads).toBe(2);
      expect(registry.getSessionControllerOperation(sessionKey)).toBeUndefined();
    } finally {
      release.resolve();
      owner.operation.complete();
      complete(await pending.catch(() => undefined));
    }
  },
);

it.for(
  (["active", "delivery"] as const).flatMap((wait) =>
    (["unchanged", "same-inode"] as const).map((replacement) => ({ wait, replacement })),
  ),
)(
  "keeps the exact database owner across $wait wait, replacement=$replacement",
  async ({ wait, replacement }, { signal }) => {
    const root = tempDirs.make("reply-admission-claim-");
    const originalPath = path.join(root, "original.sqlite");
    const storePath = path.join(root, "selected.sqlite");
    seed(originalPath);
    closeOpenClawAgentDatabasesForTest();
    fs.symlinkSync(originalPath, storePath);
    const release = createDeferred();
    const admitted = await admit(storePath);
    assert(admitted.status === "owned");
    const owner = admitted.operation;
    if (wait === "delivery") {
      owner.completeWithAfterClearBarrier(release.promise);
    }
    const enteredWait = createDeferred();
    const loaded = vi.spyOn(sessionEntries, "loadSessionEntryForAdmission");
    if (wait === "active") {
      const waitForIdle = controllerWait.waitForSessionRunIdle;
      vi.spyOn(controllerWait, "waitForSessionRunIdle").mockImplementation((...args) => {
        enteredWait.resolve();
        return waitForIdle(...args);
      });
    } else {
      const waitForAdmission = controllerWait.waitForReplyRunFollowupAdmission;
      vi.spyOn(controllerWait, "waitForReplyRunFollowupAdmission").mockImplementation((...args) => {
        enteredWait.resolve();
        return waitForAdmission(...args);
      });
    }
    const controller = new AbortController();
    const pending = admit(storePath, {
      expectedSessionId: sessionId,
      kind: "queued_followup",
      upstreamAbortSignal: controller.signal,
    });
    void pending.catch(() => {});
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          enteredWait.promise,
          pending,
          "Admission completed before reaching its owned wait",
        ),
        signal,
      );
      const observed = loaded.mock.results.at(-1);
      assert(observed?.type === "return");
      const claim = (await observed.value).databaseClaim;
      expect(claim.isCurrent()).toBe(true);
      if (replacement !== "unchanged") {
        await closeOpenClawAgentDatabaseByPathAsync(storePath);
        expect(claim.isCurrent()).toBe(false);
      }
      owner.complete();
      release.resolve();
      const result = await pending;
      if (replacement === "unchanged") {
        expect(result.status).toBe("owned");
        if (result.status === "owned") {
          expect(result.databaseClaim?.incarnation).toBe(claim.incarnation);
          result.operation.complete();
        }
      } else {
        expect(result).toMatchObject({ status: "skipped", reason: "lifecycle-invalidated" });
      }
    } finally {
      owner.complete();
      release.resolve();
      controller.abort();
      complete(await pending.catch(() => undefined));
    }
  },
);

it("cancels an in-flight admission read when its lifecycle owner interrupts ingress", async () => {
  const storePath = path.join(tempDirs.make("reply-admission-interrupt-"), "agent.sqlite");
  const interruptedKey = "agent:main:interrupted-read";
  const started = createDeferred<AbortSignal>();
  vi.spyOn(sessionEntries, "loadSessionEntryForAdmission").mockImplementation(
    async (_scope, preparation) => {
      const signal = preparation?.signal;
      assert(signal);
      started.resolve(signal);
      return await new Promise<never>((_resolve, reject) => {
        const abort = () => {
          assert(signal.reason instanceof Error);
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
        }
      });
    },
  );
  const upstream = new AbortController();
  const pending = Promise.allSettled([
    admit(storePath, {
      sessionKey: interruptedKey,
      sessionId: "interrupted-read",
      upstreamAbortSignal: upstream.signal,
    }),
  ]);
  const target = { scope: storePath, identities: [interruptedKey] };
  try {
    const signal = await started.promise;
    const reason = new Error("Synthetic lifecycle interruption");
    const interrupted = startSessionControllerInterruption({ ...target, reason });
    expect(signal.aborted).toBe(true);
    expect(upstream.signal.aborted).toBe(false);
    await interrupted.released;
    await runSessionMutation({ ...target, run: async () => {} });
    expect(await pending).toMatchObject([{ status: "rejected", reason }]);
    expect(registry.getSessionControllerOperation(interruptedKey)).toBeUndefined();
  } finally {
    upstream.abort();
    await pending;
    await runSessionMutation({ ...target, run: async () => {} });
  }
});
