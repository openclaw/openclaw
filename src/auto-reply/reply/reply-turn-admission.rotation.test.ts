import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import * as sessionEntries from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import * as sessionAdmissions from "../../sessions/session-lifecycle-admission.js";
import { createReplyOperation, type ReplyOperation } from "./reply-run-registry.js";
import { testing } from "./reply-run-registry.test-support.js";
import {
  admitTestReplyTurn,
  createSessionStore,
  createSessionStoreFor,
} from "./reply-turn-admission.test-support.js";

async function admitTestReplyOperation(params: Parameters<typeof admitTestReplyTurn>[0]) {
  const admission = await admitTestReplyTurn(params);
  if (admission.status !== "owned") {
    throw new Error("Fixture requires an admitted reply operation");
  }
  return admission.operation;
}

function createTestReplyOperation(
  overrides: Omit<Parameters<typeof createReplyOperation>[0], "resetTriggered"> &
    Partial<Pick<Parameters<typeof createReplyOperation>[0], "resetTriggered">>,
) {
  return createReplyOperation({ resetTriggered: false, ...overrides });
}

describe("reply turn admission rotation", () => {
  afterEach(() => {
    testing.resetReplyRunRegistry();
    resetDiagnosticRunActivityForTest();
  });

  it.each([
    { initiallyActive: true, beforeRead: false, rekey: false },
    { initiallyActive: false, beforeRead: false, rekey: false },
    { initiallyActive: false, beforeRead: true, rekey: false },
    { initiallyActive: false, beforeRead: false, rekey: true },
  ])(
    "revalidates a run rotation during admission (initially active=$initiallyActive, before read=$beforeRead, rekey=$rekey)",
    async ({ initiallyActive, beforeRead, rekey }) => {
      const sessionKey = "agent:main:telegram:topic:compaction";
      const sessionId = "pre-compact-session";
      const nextSessionId = "post-compact-session";
      const storePath = createSessionStoreFor(sessionKey, sessionId);
      let active = initiallyActive
        ? await admitTestReplyOperation({ sessionKey, sessionId, storePath })
        : undefined;
      active?.setPhase("preflight_compacting");

      const snapshotRead = createDeferred();
      const returnAdmission = createDeferred();
      const beginAdmission = sessionAdmissions.beginSessionWorkAdmission;
      const delayedAdmission = vi
        .spyOn(sessionAdmissions, "beginSessionWorkAdmission")
        .mockImplementationOnce(async (params) => {
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
        });

      const admitted = admitTestReplyTurn({
        sessionKey,
        sessionId,
        expectedSessionId: sessionId,
        storePath,
      });

      try {
        await snapshotRead.promise;
        if (!active) {
          active = await admitTestReplyOperation({ sessionKey, sessionId, storePath });
          if (!rekey) {
            active.setPhase("preflight_compacting");
          }
        }
        await replaceSessionEntry({ sessionKey, storePath }, {
          sessionId: nextSessionId,
          label: "fresh compaction facts",
          updatedAt: Date.now(),
        } as SessionEntry);
        active.updateSessionId(nextSessionId);
        if (rekey) {
          active.updateSessionKey("agent:main:telegram:topic:other-compaction");
        } else {
          active.complete();
        }
        returnAdmission.resolve();
        if (rekey) {
          await expect(admitted).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
          return;
        }
        const result = await admitted;

        expect(result.status).toBe("owned");
        if (result.status === "owned") {
          expect(result.operation.sessionId).toBe(nextSessionId);
          expect(result.sessionEntry?.sessionId).toBe(nextSessionId);
          expect(result.sessionEntry?.label).toBe("fresh compaction facts");
        }
      } finally {
        returnAdmission.resolve();
        delayedAdmission.mockRestore();
        active?.complete();
        const result = await admitted.catch(() => undefined);
        if (result?.status === "owned") {
          result.operation.complete();
        }
      }
    },
  );

  it("retries after an admitted owner enters and leaves during one read", async () => {
    const sessionKey = "agent:main:telegram:topic:transient-owner";
    const sessionId = "stable-session";
    const storePath = createSessionStoreFor(sessionKey, sessionId);
    const preparationWitness = createTestReplyOperation({
      sessionKey: `${sessionKey}:preparation-witness`,
      sessionId: "preparation-witness",
      turnKind: "visible",
    });
    let registeringOwner = false;
    let transientOwner: ReplyOperation | undefined;
    const ownerObserved = createDeferred();
    const releaseRead = createDeferred();
    const load = sessionEntries.loadSessionEntryForAdmission;
    let reads = 0;
    let transientOwnerCompleted = false;
    let readAfterTransientOwnerCompletion = false;
    const loadSpy = vi
      .spyOn(sessionEntries, "loadSessionEntryForAdmission")
      .mockImplementation(async (...args) => {
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
          try {
            transientOwner = await admitTestReplyOperation({ sessionKey, sessionId, storePath });
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
    const admitted = admitTestReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      expectedActiveOperations: [preparationWitness],
      storePath,
      kind: "queued_followup",
    });

    try {
      await ownerObserved.promise;
      releaseRead.resolve();
      const result = await admitted;
      expect(readAfterTransientOwnerCompletion).toBe(true);
      expect(result.status).toBe("owned");
      if (result.status === "owned") {
        expect(result.operation.sessionId).toBe(sessionId);
        result.operation.complete();
      }
    } finally {
      releaseRead.resolve();
      transientOwner?.complete();
      preparationWitness.complete();
      const result = await admitted.catch(() => undefined);
      if (result?.status === "owned") {
        result.operation.complete();
      }
      loadSpy.mockRestore();
    }
  });

  it("accepts a rotation already published by the expected active run", async () => {
    const sessionKey = "agent:main:telegram:topic:compaction-before-admission";
    const sessionId = "pre-compact-session";
    const nextSessionId = "post-compact-session";
    const storePath = createSessionStoreFor(sessionKey, sessionId);
    const active = await admitTestReplyOperation({
      sessionKey,
      sessionId,
      storePath,
    });
    active.setPhase("preflight_compacting");
    active.updateSessionId(nextSessionId);
    await replaceSessionEntry({ sessionKey, storePath }, {
      sessionId: nextSessionId,
      updatedAt: Date.now(),
    } as SessionEntry);
    active.complete();

    const result = await admitTestReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      expectedActiveOperations: [active],
      storePath,
    });

    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      expect(result.operation.sessionId).toBe(nextSessionId);
      result.operation.complete();
    }
  });

  it("accepts a rotation published by the live owner after the caller snapshot", async () => {
    const sessionKey = "agent:main:telegram:topic:late-compaction-owner";
    const sessionId = "pre-compact-session";
    const nextSessionId = "post-compact-session";
    const storePath = createSessionStoreFor(sessionKey, sessionId);
    const active = await admitTestReplyOperation({
      sessionKey,
      sessionId,
      storePath,
    });
    active.setPhase("preflight_compacting");
    active.updateSessionId(nextSessionId);
    await replaceSessionEntry({ sessionKey, storePath }, {
      sessionId: nextSessionId,
      updatedAt: Date.now(),
    } as SessionEntry);

    const admitted = admitTestReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      waitForActive: true,
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    active.complete();
    const result = await admitted;

    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      expect(result.operation.sessionId).toBe(nextSessionId);
      result.operation.complete();
    }
  });

  it("rejects a fresh post-reset owner as rotation proof", async () => {
    const sessionKey = "agent:main:telegram:topic:fresh-post-reset-owner";
    const sessionId = "session-before-reset";
    const nextSessionId = "session-after-reset";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId: nextSessionId, updatedAt: Date.now() },
    });
    const freshOwner = await admitTestReplyOperation({
      sessionKey,
      sessionId: nextSessionId,
      storePath,
    });

    const admitted = admitTestReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      waitForActive: true,
    });

    await expect(admitted).rejects.toThrow(/changed while starting work/i);
    freshOwner.complete();
  });

  it.each([
    [
      "failed",
      (operation: ReplyOperation) => {
        operation.fail("run_failed");
        operation.complete();
      },
    ],
    [
      "user-aborted",
      (operation: ReplyOperation) => {
        operation.abortByUser();
        operation.complete();
      },
    ],
  ])("accepts a rotation published before the expected run %s", async (_outcome, finish) => {
    const sessionKey = "agent:main:telegram:topic:compaction-terminal-outcome";
    const sessionId = "pre-compact-session";
    const nextSessionId = "post-compact-session";
    const storePath = createSessionStoreFor(sessionKey, sessionId);
    const active = await admitTestReplyOperation({
      sessionKey,
      sessionId,
      storePath,
    });
    active.setPhase("preflight_compacting");
    active.updateSessionId(nextSessionId);
    await replaceSessionEntry({ sessionKey, storePath }, {
      sessionId: nextSessionId,
      updatedAt: Date.now(),
    } as SessionEntry);
    finish(active);

    const result = await admitTestReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      expectedActiveOperations: [active],
      storePath,
    });

    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      expect(result.operation.sessionId).toBe(nextSessionId);
      result.operation.complete();
    }
  });
});
