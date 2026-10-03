import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createSessionMaintenanceOwner } from "../../agents/session-maintenance/coordinator.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import * as registry from "./reply-run-registry.js";
import { testing } from "./reply-run-registry.test-support.js";
import { admitReplyTurn } from "./reply-turn-admission.js";

type Admission = Awaited<ReturnType<typeof admitReplyTurn>>;
const operations = new Set<registry.ReplyOperation>();
const releases: (() => void)[] = [];
const admissions: Promise<Admission>[] = [];
const work: Promise<unknown>[] = [];
let controller = new AbortController();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    controller.abort();
    operations.forEach((operation) => operation.complete());
    releases.forEach((release) => release());
    await Promise.allSettled(work);
    for (const pending of admissions) {
      const result = await pending.catch(() => undefined);
      if (result?.status === "owned") {
        result.operation.complete();
      }
    }
    testing.resetReplyRunRegistry();
    await closeOpenClawAgentDatabasesAsync();
    vi.restoreAllMocks();
    cleanup();
    operations.clear();
    releases.length = admissions.length = work.length = 0;
    controller = new AbortController();
  }),
);
const sessionKey = "global";
const sessionId = "copied-session-id";
const successorId = "compacted-session-id";
const invalidated = { status: "skipped", reason: "lifecycle-invalidated" };

function seed(storePath: string, id = sessionId, key = sessionKey) {
  replaceSessionEntrySync({ storePath, sessionKey: key }, { sessionId: id, updatedAt: 1 });
}
function store() {
  const storePath = path.join(tempDirs.make("reply-owner-"), "sessions.json");
  seed(storePath);
  return storePath;
}
function deferred() {
  const value = createDeferred();
  releases.push(value.resolve);
  return value;
}
function admit(storePath?: string, overrides: Partial<Parameters<typeof admitReplyTurn>[0]> = {}) {
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
function owned(result: Admission) {
  expect(result.status).toBe("owned");
  if (result.status !== "owned") {
    throw new Error("fixture requires an admitted owner");
  }
  operations.add(result.operation);
  return result;
}
async function owner(storePath?: string, id = sessionId) {
  return owned(await admit(storePath, { sessionId: id })).operation;
}
function queue(storePath?: string, id = sessionId) {
  return admit(storePath, {
    sessionId: id,
    expectedSessionId: id,
    kind: "queued_followup",
    upstreamAbortSignal: controller.signal,
  });
}
function rotate(operation: registry.ReplyOperation, storePath: string, id = successorId) {
  operation.updateSessionId(id);
  seed(storePath, id);
}
function expectRotated(result: Admission, id = successorId) {
  const { operation } = owned(result);
  expect(operation.sessionId).toBe(id);
  operation.complete();
}

it("preserves same-store rotation across foreground maintenance", async () => {
  const ownerStore = store();
  const admitted = owned(await admit(ownerStore, { agentId: "main" }));
  const active = admitted.operation;
  if (!admitted.databaseClaim) {
    throw new Error("fixture requires a physical database claim");
  }
  const maintenanceStarted = deferred();
  const releaseMaintenance = deferred();
  const maintenance = createSessionMaintenanceOwner({ sessionKey });
  const running = maintenance.track(
    maintenance.run(async () => {
      maintenanceStarted.resolve();
      await releaseMaintenance.promise;
    }),
  );
  work.push(running);
  await maintenanceStarted.promise;
  let settled = false;
  const pending = admit(ownerStore, {
    agentId: "main",
    expectedSessionId: sessionId,
    upstreamAbortSignal: controller.signal,
  });
  void pending
    .finally(() => {
      settled = true;
    })
    .catch(() => {});
  rotate(active, ownerStore);
  active.complete();
  await Promise.resolve();
  expect(registry.replyRunRegistry.get(sessionKey)).toBeUndefined();
  expect(settled).toBe(false);
  releaseMaintenance.resolve();
  await running;
  const result = owned(await pending);
  const next = result.operation;
  expect(next.sessionId).toBe(successorId);
  expect(next.agentId).toBe("main");
  expect(result.databaseClaim?.incarnation).toBe(admitted.databaseClaim.incarnation);
  next.complete();
});

it("rejects rotation after the waited owner adopts another physical store", async () => {
  const ownerStore = store();
  const adoptedStore = store();
  const active = await owner(ownerStore);
  const waited = vi.spyOn(registry.replyRunRegistry, "waitForIdle");
  const pending = queue(ownerStore);
  await vi.waitFor(() => expect(waited).toHaveBeenCalled());
  owned(await admit(adoptedStore, { expectedSessionId: sessionId, adoptOperation: active }));
  seed(ownerStore, successorId);
  rotate(active, adoptedStore);
  active.complete();
  await expect(pending).resolves.toMatchObject(invalidated);
});

it("keeps same-store rotation when a foreign barrier is already installed", async () => {
  const ownerStore = store();
  const foreignStore = store();
  const first = await owner(ownerStore);
  const delivery = deferred();
  const foreignDelivery = deferred();
  first.completeWithAfterClearBarrier(delivery.promise);
  const waited = vi.spyOn(registry, "waitForReplyRunFollowupAdmission");
  const pending = queue(ownerStore);
  await vi.waitFor(() => expect(waited).toHaveBeenCalled());
  (await owner(foreignStore)).completeWithAfterClearBarrier(foreignDelivery.promise);
  const visible = await owner(ownerStore);
  rotate(visible, ownerStore);
  visible.complete();
  delivery.resolve();
  foreignDelivery.resolve();
  expectRotated(await pending);
});

it("rejects a storeless unrelated replacement with a delivery barrier", async () => {
  const first = await owner();
  const delivery = deferred();
  const replacementDelivery = deferred();
  first.completeWithAfterClearBarrier(delivery.promise);
  const waited = vi.spyOn(registry, "waitForReplyRunFollowupAdmission");
  const pending = queue();
  await vi.waitFor(() => expect(waited).toHaveBeenCalled());
  const replacement = await owner(undefined, "unrelated-replacement");
  expect(replacement.sessionId).toBe("unrelated-replacement");
  expect(replacement.captureOwnedSessionIds().has(sessionId)).toBe(false);
  replacement.completeWithAfterClearBarrier(replacementDelivery.promise);
  delivery.resolve();
  replacementDelivery.resolve();
  await expect(pending).resolves.toMatchObject(invalidated);
});

it("keeps rekeyed source lineage separate from the adopted target", async () => {
  const storePath = store();
  const first = await owner(storePath);
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
    await admit(storePath, {
      sessionKey: targetKey,
      sessionId: successorId,
      expectedSessionId: targetId,
      adoptOperation: first,
    }),
  );
  first.updateSessionId(targetId);
  expect(first.captureOwnedSessionIds().has(targetId)).toBe(true);
  const waited = vi.spyOn(registry, "waitForReplyRunSuccessorAdmission");
  const pending = [sessionId, targetId].map(async (id) => {
    const result = await queue(storePath, id);
    if (result.status !== "owned") {
      return { status: result.status, reason: result.reason };
    }
    result.operation.complete();
    return { status: result.status, sessionId: result.operation.sessionId };
  });
  work.push(...pending);
  await vi.waitFor(() => expect(waited).toHaveBeenCalledTimes(2));
  first.complete();
  release.resolve();
  await expect(Promise.all(pending)).resolves.toEqual([
    { status: "owned", sessionId: successorId },
    invalidated,
  ]);
});

it.each(["user", "restart"])("invalidates restart ancestry: %s", async (terminal) => {
  const storePath = store();
  const initial = await owner(storePath);
  const delivery = deferred();
  initial.completeWithAfterClearBarrier(delivery.promise);
  const waited = vi.spyOn(registry, "waitForReplyRunFollowupAdmission");
  const pending = queue(storePath);
  await vi.waitFor(() => expect(waited).toHaveBeenCalledTimes(1));
  const predecessor = await owner(storePath);
  rotate(predecessor, storePath);
  expect(terminal === "restart" ? predecessor.abortForRestart() : predecessor.abortByUser()).toBe(
    true,
  );
  predecessor.completeWithAfterClearBarrier(delivery.promise);
  const successor = await owner(storePath);
  rotate(successor, storePath, "second-compaction");
  successor.complete();
  delivery.resolve();
  const result = await pending;
  if (terminal === "restart") {
    expect(result).toMatchObject(invalidated);
  } else {
    expectRotated(result, "second-compaction");
  }
});
