import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import * as sessionEntries from "../../config/sessions/session-accessor.sqlite-entry.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import * as sessionAdmissions from "../../sessions/session-lifecycle-admission.js";
import { createReplyOperation, type ReplyOperation } from "./reply-run-registry.js";
import { testing } from "./reply-run-registry.test-support.js";
import { admitTestReplyTurn, createSessionStoreFor } from "./reply-turn-admission.test-support.js";

const sessionKey = "agent:main:telegram:topic:compaction";
const sessionId = "pre-compact-session";
const nextSessionId = "post-compact-session";
const operations: ReplyOperation[] = [];
const releases: (() => void)[] = [];
const admissions: ReturnType<typeof admitTestReplyTurn>[] = [];
afterEach(async () => {
  releases.forEach((release) => release());
  operations.forEach((operation) => operation.complete());
  for (const pending of admissions) {
    const result = await pending.catch(() => undefined);
    if (result?.status === "owned") {
      result.operation.complete();
    }
  }
  testing.resetReplyRunRegistry();
  resetDiagnosticRunActivityForTest();
  vi.restoreAllMocks();
  operations.length = releases.length = admissions.length = 0;
});
function deferred() {
  const value = createDeferred();
  releases.push(value.resolve);
  return value;
}
function admit(
  storePath: string,
  overrides: Partial<Parameters<typeof admitTestReplyTurn>[0]> = {},
) {
  const pending = admitTestReplyTurn({ sessionKey, sessionId, storePath, ...overrides });
  admissions.push(pending);
  void pending.catch(() => {});
  return pending;
}
function owned(result: Awaited<ReturnType<typeof admit>>) {
  expect(result.status).toBe("owned");
  if (result.status !== "owned") {
    throw new Error("Fixture requires an admitted reply operation");
  }
  operations.push(result.operation);
  return result;
}
async function rotate(storePath: string, active: ReplyOperation) {
  await replaceSessionEntry(
    { sessionKey, storePath },
    {
      sessionId: nextSessionId,
      label: "fresh compaction facts",
      updatedAt: Date.now(),
    },
  );
  active.updateSessionId(nextSessionId);
}

it.each([
  { beforeRead: false, rekey: false },
  { beforeRead: true, rekey: false },
  { beforeRead: false, rekey: true },
])(
  "revalidates rotation during admission: beforeRead=$beforeRead, rekey=$rekey",
  async ({ beforeRead, rekey }) => {
    const storePath = createSessionStoreFor(sessionKey, sessionId);
    const snapshotRead = deferred();
    const returnAdmission = deferred();
    const beginAdmission = sessionAdmissions.beginSessionWorkAdmission;
    vi.spyOn(sessionAdmissions, "beginSessionWorkAdmission").mockImplementationOnce(
      async (params) => {
        if (beforeRead) {
          snapshotRead.resolve();
          await returnAdmission.promise;
        }
        const lease = await beginAdmission(params);
        if (!beforeRead) {
          snapshotRead.resolve();
          await returnAdmission.promise;
        }
        return lease;
      },
    );
    const pending = admit(storePath, { expectedSessionId: sessionId });
    await snapshotRead.promise;
    const { operation: active } = owned(await admit(storePath));
    if (!rekey) {
      active.setPhase("preflight_compacting");
    }
    await rotate(storePath, active);
    if (rekey) {
      active.updateSessionKey("agent:main:telegram:topic:other-compaction");
    } else {
      active.complete();
    }
    returnAdmission.resolve();
    if (rekey) {
      await expect(pending).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
      return;
    }
    const result = owned(await pending);
    expect(result.operation.sessionId).toBe(nextSessionId);
    expect(result.sessionEntry?.sessionId).toBe(nextSessionId);
    expect(result.sessionEntry?.label).toBe("fresh compaction facts");
  },
);

it("retries after an admitted owner enters and leaves during one read", async () => {
  const storePath = createSessionStoreFor(sessionKey, sessionId);
  const preparationWitness = createReplyOperation({
    sessionKey: `${sessionKey}:preparation-witness`,
    sessionId: "preparation-witness",
    turnKind: "visible",
    resetTriggered: false,
  });
  operations.push(preparationWitness);
  let registeringOwner = false;
  const ownerObserved = deferred();
  const releaseRead = deferred();
  const load = sessionEntries.loadSessionEntryForAdmission;
  let reads = 0;
  let transientOwnerCompleted = false;
  let readAfterTransientOwnerCompletion = false;
  vi.spyOn(sessionEntries, "loadSessionEntryForAdmission").mockImplementation(async (...args) => {
    if (registeringOwner) {
      return await load(...args);
    }
    const read = ++reads;
    if (transientOwnerCompleted) {
      readAfterTransientOwnerCompletion = true;
    }
    const snapshot = await load(...args);
    if (read === 1) {
      preparationWitness.updateSessionId("rotated-preparation-witness");
    } else if (read === 2) {
      registeringOwner = true;
      let transientOwner: ReplyOperation;
      try {
        transientOwner = owned(await admit(storePath)).operation;
      } finally {
        registeringOwner = false;
      }
      transientOwner.updateSessionId("transient-rotation");
      transientOwner.complete();
      transientOwnerCompleted = true;
      ownerObserved.resolve();
      await releaseRead.promise;
    }
    return snapshot;
  });
  const pending = admit(storePath, {
    expectedSessionId: sessionId,
    expectedActiveOperations: [preparationWitness],
    kind: "queued_followup",
  });
  await ownerObserved.promise;
  releaseRead.resolve();
  const result = owned(await pending);
  expect(readAfterTransientOwnerCompletion).toBe(true);
  expect(result.operation.sessionId).toBe(sessionId);
  result.operation.complete();
});

it("accepts a rotation published before the expected run failed", async () => {
  const storePath = createSessionStoreFor(sessionKey, sessionId);
  const { operation: active } = owned(await admit(storePath));
  active.setPhase("preflight_compacting");
  await rotate(storePath, active);
  active.fail("run_failed");
  active.complete();
  const result = await admit(storePath, {
    expectedSessionId: sessionId,
    expectedActiveOperations: [active],
  });
  expect(owned(result).operation.sessionId).toBe(nextSessionId);
});
