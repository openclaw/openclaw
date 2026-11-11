import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createSessionMaintenanceOwner } from "../../agents/session-maintenance/coordinator.js";
import { SessionWorkStartChangedError } from "../../config/sessions/lifecycle.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import * as registry from "../../sessions/session-controller.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  tryClaimSessionControllerTask,
  claimSessionControllerTask,
  releaseSessionControllerClaim,
} from "../../sessions/session-controller.mailbox.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import * as controllerWait from "../../sessions/session-controller.wait.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { admitReplyTurn } from "./reply-turn-admission.js";

type Admission = Awaited<ReturnType<typeof admitReplyTurn>>;
type Request = Partial<Parameters<typeof admitReplyTurn>[0]>;
const operations = new Set<registry.ReplyOperation>();
const releases: (() => void)[] = [];
const admissions: Promise<Admission>[] = [];
const pendingWork: Promise<unknown>[] = [];
let suiteAbort = new AbortController();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    suiteAbort.abort();
    operations.forEach((operation) => operation.complete());
    releases.forEach((release) => release());
    await Promise.allSettled(pendingWork);
    for (const pending of admissions) {
      const result = await pending.catch(() => undefined);
      complete(result);
    }
    testing.resetSessionControllerForTest();
    await closeOpenClawAgentDatabasesAsync();
    vi.restoreAllMocks();
    cleanup();
    operations.clear();
    releases.length = admissions.length = pendingWork.length = 0;
    suiteAbort = new AbortController();
  }),
);
const sessionKey = "global";
const sessionId = "copied-session-id";
const successorId = "compacted-session-id";

function request(storePath: string | undefined, overrides: Request = {}) {
  const pending = admitReplyTurn({
    sessionKey,
    sessionId,
    storePath,
    kind: "visible",
    resetTriggered: false,
    ...overrides,
  });
  admissions.push(pending);
  void pending.catch(() => {});
  return pending;
}
function complete(result: Admission | undefined) {
  if (result?.status === "owned") {
    result.operation.complete();
  }
}
function seed(storePath: string, id = sessionId, key = sessionKey) {
  replaceSessionEntrySync({ storePath, sessionKey: key }, { sessionId: id, updatedAt: 1 });
}

async function admitOwner(storePath?: string, id = sessionId) {
  return owned(await request(storePath, { sessionId: id })).operation;
}

it.each(
  (["active", "successor", "followup"] as const).flatMap((barrier) =>
    [true, false].map((sameStore) => ({ barrier, sameStore })),
  ),
)(
  "follows $barrier rotation only in its physical store, sameStore=$sameStore",
  async ({ barrier, sameStore }) => {
    const ownerStore = store();
    const targetStore = sameStore ? ownerStore : store();
    const owner = await admitOwner(ownerStore);
    const released = deferred();
    const entered = deferred();
    const waitForIdle = controllerWait.waitForSessionRunIdle;
    const waitForSuccessor = controllerWait.waitForReplyRunSuccessorAdmission;
    const waitForFollowup = controllerWait.waitForReplyRunFollowupAdmission;
    const waited =
      barrier === "active"
        ? vi
            .spyOn(controllerWait, "waitForSessionRunIdle")
            .mockImplementation(observeCall(waitForIdle, entered.resolve))
        : barrier === "successor"
          ? vi
              .spyOn(controllerWait, "waitForReplyRunSuccessorAdmission")
              .mockImplementation(observeCall(waitForSuccessor, entered.resolve))
          : vi
              .spyOn(controllerWait, "waitForReplyRunFollowupAdmission")
              .mockImplementation(observeCall(waitForFollowup, entered.resolve));
    if (barrier === "successor") {
      registry.registerReplyOperationSuccessorBarrier({
        operation: owner,
        sessionId,
        sessionKeys: [sessionKey],
        start: () => released.promise,
      });
      rotate(owner, ownerStore);
      owner.complete();
    } else if (barrier === "followup") {
      // Commit rotation before handing off delivery.
      rotate(owner, ownerStore);
      owner.completeWithAfterClearBarrier(released.promise);
    }
    const pending = request(targetStore, {
      expectedSessionId: sessionId,
      kind: "queued_followup",
    });
    // Foreign stores neither wait on this owner nor inherit its rotation.
    const independent = sameStore ? undefined : await pending;
    if (sameStore) {
      await entered.promise;
      expect(waited).toHaveBeenCalled();
    } else {
      expect(independent?.status).toBe("owned");
      expect(waited).not.toHaveBeenCalled();
    }
    if (barrier === "active") {
      rotate(owner, ownerStore);
      owner.complete();
    }
    released.resolve();
    const result = owned(independent ?? (await pending));
    expect(result.operation.sessionId).toBe(sameStore ? successorId : sessionId);
    result.operation.complete();
  },
);

it.each([true, false])(
  "follows a rotation completed during foreground maintenance only in its physical store, sameStore=%s",
  async (sameStore) => {
    const ownerStore = store();
    const targetStore = sameStore ? ownerStore : store();
    const admitted = owned(await request(ownerStore, { agentId: "main" }));
    if (!admitted.databaseClaim) {
      throw new Error("fixture requires a reply owner with its physical database claim");
    }
    const { operation: owner, databaseClaim } = admitted;
    const maintenanceStarted = deferred();
    const releaseMaintenance = deferred();
    const maintenance = createSessionMaintenanceOwner({ sessionKey });
    const work = maintenance.track(
      maintenance.run(async () => {
        maintenanceStarted.resolve();
        await releaseMaintenance.promise;
      }),
    );
    pendingWork.push(work);
    await maintenanceStarted.promise;
    const controller = new AbortController();
    releases.push(() => controller.abort());
    let settled = false;
    const pending = request(targetStore, {
      agentId: "main",
      expectedSessionId: sessionId,
      upstreamAbortSignal: controller.signal,
    }).finally(() => {
      settled = true;
    });
    void pending.catch(() => {});
    owner.updateSessionId(successorId);
    seed(ownerStore, successorId);
    if (!sameStore) {
      // Matching UUIDs in another physical database do not establish rotation lineage.
      seed(targetStore, successorId);
    }
    owner.complete();
    await Promise.resolve();
    expect(registry.getSessionControllerOperation(sessionKey)).toBeUndefined();
    expect(settled).toBe(false);

    releaseMaintenance.resolve();
    await work;
    if (sameStore) {
      const result = owned(await pending);
      expect(result.operation.sessionId).toBe(successorId);
      expect(result.operation.agentId).toBe("main");
      expect(result.databaseClaim?.incarnation).toBe(databaseClaim.incarnation);
      result.operation.complete();
    } else {
      await expect(pending).rejects.toThrow(SessionWorkStartChangedError);
    }
  },
);
const invalidated = { status: "skipped", reason: "lifecycle-invalidated" };

function store() {
  const storePath = path.join(tempDirs.make("reply-owner-"), "sessions.json");
  seed(storePath);
  return storePath;
}
function observeCall<A extends unknown[], R>(run: (...args: A) => R, notify: () => void) {
  return (...args: A) => {
    const result = run(...args);
    notify();
    return result;
  };
}
function reserve(storePath: string) {
  return reserveSessionControllerSource(sessionKey, {
    target: captureSessionTarget({ storeScope: storePath, sessionKey }),
    policy: { mode: "followup" },
  });
}
function deferred() {
  const value = createDeferred();
  releases.push(value.resolve);
  return value;
}
function owned(result: Admission) {
  assert(result.status === "owned", "fixture requires an admitted owner");
  operations.add(result.operation);
  return result;
}
function queue(storePath?: string, id = sessionId) {
  return request(storePath, {
    sessionId: id,
    expectedSessionId: id,
    kind: "queued_followup",
    upstreamAbortSignal: suiteAbort.signal,
  });
}
function rotate(operation: registry.ReplyOperation, storePath: string, id = successorId) {
  operation.updateSessionId(id);
  seed(storePath, id);
}
it.each(["before", "after"] as const)(
  "keeps same-store rotation when a foreign barrier is installed %s the rotation",
  async (foreignOrder) => {
    const ownerStore = store();
    const foreignStore = store();
    const owner = await admitOwner(ownerStore);
    const ownerDelivery = deferred();
    const foreignDelivery = deferred();
    const waited = vi.spyOn(controllerWait, "waitForReplyRunFollowupAdmission");
    const installForeignBarrier = async () => {
      const foreign = await admitOwner(foreignStore);
      foreign.completeWithAfterClearBarrier(foreignDelivery.promise);
    };
    if (foreignOrder === "before") {
      await installForeignBarrier();
    }
    seed(ownerStore, successorId);
    owner.updateSessionId(successorId);
    owner.completeWithAfterClearBarrier(ownerDelivery.promise);
    if (foreignOrder === "after") {
      await installForeignBarrier();
    }
    const pending = request(ownerStore, {
      expectedSessionId: sessionId,
      kind: "queued_followup",
    });
    await vi.waitFor(() => expect(waited).toHaveBeenCalled());
    ownerDelivery.resolve();
    const result = owned(await pending);
    expect(result.operation.sessionId).toBe(successorId);
    result.operation.complete();
  },
);

it.each(["completed", "user-aborted", "restart-aborted"] as const)(
  "follows connected serialized compactions only with valid predecessor lineage: %s",
  async (terminal) => {
    const storePath = store();
    const first = await admitOwner(storePath);
    first.updateSessionId(successorId);
    seed(storePath, successorId);
    if (terminal === "user-aborted") {
      first.abortByUser();
    }
    if (terminal === "restart-aborted") {
      first.abortForRestart();
    }
    const delivery = deferred();
    first.completeWithAfterClearBarrier(delivery.promise);
    const firstSource = reserve(storePath);
    const secondAdmission = claimSessionControllerTask(firstSource, () => {}).then(
      async (claim) => {
        const admitted = owned(
          await request(storePath, {
            sessionId: successorId,
            mailboxClaim: claim,
          }),
        );
        return admitted.operation;
      },
    );
    let secondStarted = false;
    void secondAdmission.then(() => {
      secondStarted = true;
    });
    expect(secondStarted).toBe(false);
    delivery.resolve();
    const second = await secondAdmission;
    const waitingSource = reserve(storePath);
    second.updateSessionId("second-compaction");
    seed(storePath, "second-compaction");
    // Lineage follows exact owners, not matching copied UUIDs.
    second.complete();
    releaseSessionControllerClaim(firstSource.claim!);
    await firstSource.claim!.settlement.promise;
    const selected = await claimSessionControllerTask(waitingSource, () => {});
    const result = await request(storePath, {
      expectedSessionId: sessionId,
      mailboxClaim: selected,
      expectedActiveOperations: [first, second],
      kind: "queued_followup",
    });
    if (terminal === "restart-aborted") {
      expect(result).toMatchObject({ status: "skipped", reason: "lifecycle-invalidated" });
    } else {
      const admitted = owned(result);
      expect(admitted.operation.sessionId).toBe("second-compaction");
      admitted.operation.complete();
    }
    releaseSessionControllerClaim(selected);
    await selected.settlement.promise;
  },
);

it("rejects a replacement committed while the predecessor delivery retains custody", async () => {
  const storePath = store();
  const owner = await admitOwner(storePath);
  const delivery = deferred();
  owner.completeWithAfterClearBarrier(delivery.promise);
  const waiting = deferred();
  const wait = controllerWait.waitForReplyRunFollowupAdmission;
  vi.spyOn(controllerWait, "waitForReplyRunFollowupAdmission").mockImplementation((...args) => {
    const result = wait(...args);
    waiting.resolve();
    return result;
  });
  const pending = request(storePath, {
    expectedSessionId: sessionId,
    kind: "queued_followup",
  });
  await waiting.promise;
  seed(storePath, "unrelated-session");
  delivery.resolve();
  await expect(pending).resolves.toMatchObject({
    status: "skipped",
    reason: "lifecycle-invalidated",
  });
  await owner.ownerSettlement;
});

it("keeps rekeyed source lineage separate from the adopted target", async () => {
  const storePath = store();
  const first = await admitOwner(storePath);
  const release = deferred();
  registry.registerReplyOperationSuccessorBarrier({
    operation: first,
    sessionId,
    sessionKeys: [sessionKey],
    start: () => release.promise,
  });
  rotate(first, storePath);
  const targetKey = "agent:main:adopted-target";
  const targetId = "adopted-session";
  seed(storePath, targetId, targetKey);
  owned(
    await request(storePath, {
      sessionKey: targetKey,
      sessionId: successorId,
      expectedSessionId: targetId,
      adoptOperation: first,
    }),
  );
  first.updateSessionId(targetId);
  expect(first.captureOwnedSessionIds().has(targetId)).toBe(true);
  const waited = vi.spyOn(controllerWait, "waitForReplyRunSuccessorAdmission");
  const pending = [sessionId, targetId].map(async (id) => {
    const result = await queue(storePath, id);
    if (result.status !== "owned") {
      return { status: result.status, reason: result.reason };
    }
    result.operation.complete();
    return { status: result.status, sessionId: result.operation.sessionId };
  });
  pendingWork.push(...pending);
  await vi.waitFor(() => expect(waited).toHaveBeenCalledTimes(2));
  first.complete();
  release.resolve();
  await expect(Promise.all(pending)).resolves.toEqual([
    { status: "owned", sessionId: successorId },
    invalidated,
  ]);
});
it("admits selected mailbox claims independently for identical keys in two stores", async () => {
  const firstStore = store();
  const secondStore = store();
  const firstSource = reserve(firstStore);
  const secondSource = reserve(secondStore);
  const firstClaim = tryClaimSessionControllerTask(firstSource)!;
  const secondClaim = tryClaimSessionControllerTask(secondSource)!;
  const first = owned(await request(firstStore, { mailboxClaim: firstClaim }));
  const second = owned(await request(secondStore, { mailboxClaim: secondClaim }));
  expect(firstSource.mailbox.owner.active).toBe(first.operation);
  expect(secondSource.mailbox.owner.active).toBe(second.operation);
  expect(first.operation.result).toBeNull();
  first.operation.complete();
  second.operation.complete();
  releaseSessionControllerClaim(firstClaim);
  releaseSessionControllerClaim(secondClaim);
  await Promise.all([first.operation.ownerSettlement, second.operation.ownerSettlement]);
});

it("rejects moving an admitted operation into a different physical store", async () => {
  const ownerStore = store();
  const adoptedStore = store();
  const active = await admitOwner(ownerStore);
  await expect(
    request(adoptedStore, { expectedSessionId: sessionId, adoptOperation: active }),
  ).rejects.toThrow(/physical|store/i);
  expect(active.result).toBeNull();
  active.complete();
});
