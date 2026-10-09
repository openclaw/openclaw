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
import { runExclusiveSessionStoreWrite } from "../../config/sessions/store-writer.js";
import {
  runExclusiveSessionLifecycleMutation,
  startSessionWorkAdmissionInterruption,
} from "../../sessions/session-lifecycle-admission.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import * as registry from "./reply-run-registry.js";
import { testing } from "./reply-run-registry.test-support.js";
import { admitReplyTurn } from "./reply-turn-admission.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    testing.resetReplyRunRegistry();
    await closeOpenClawAgentDatabasesAsync();
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

it.each(["cancelled", "request-changed", "later-rebound-store"] as const)(
  "does not admit a delayed healthy rotation after %s",
  async (change) => {
    const root = tempDirs.make("reply-delayed-rotation-");
    const storePath = path.join(root, "owner.sqlite");
    const foreignStore = path.join(root, "target.sqlite");
    const nextSessionId = "after-compaction";
    seed(storePath);
    if (change === "later-rebound-store") {
      seed(foreignStore);
    }
    let preparingOwner = false;
    const registerOwner = async () => {
      preparingOwner = true;
      try {
        const result = await admit(storePath);
        if (result.status !== "owned" || !result.databaseClaim) {
          throw new Error("Fixture requires an admitted physical database owner");
        }
        return result;
      } finally {
        preparingOwner = false;
      }
    };
    let owner = change.startsWith("later-") ? undefined : await registerOwner();
    const captured =
      createDeferred<Awaited<ReturnType<typeof sessionEntries.loadSessionEntryForAdmission>>>();
    const release = createDeferred();
    const load = sessionEntries.loadSessionEntryForAdmission;
    let reads = 0;
    vi.spyOn(sessionEntries, "loadSessionEntryForAdmission").mockImplementation(async (...args) => {
      if (preparingOwner) {
        return await load(...args);
      }
      const read = ++reads;
      const snapshot = await load(...args);
      if (read === 1 && change.startsWith("later-")) {
        expect(registry.replyRunRegistry.get(sessionKey)).toBeUndefined();
        owner = await registerOwner();
      }
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
      const snapshot = await Promise.race([
        captured.promise,
        pending.then(() => {
          throw new Error("Admission completed before its final snapshot was captured");
        }),
      ]);
      expect(snapshot.entry?.sessionId).toBe(sessionId);
      expect(snapshot.databaseClaim.isCurrent()).toBe(true);
      if (!owner?.databaseClaim) {
        throw new Error("Fixture requires the admitted predecessor before rotation");
      }
      expect(snapshot.databaseClaim.identity).toBe(owner.databaseClaim.identity);
      await sessionEntries.replaceSessionEntry(
        { storePath, sessionKey },
        { sessionId: nextSessionId, updatedAt: 2 },
      );
      if (change === "later-rebound-store") {
        preparingOwner = true;
        try {
          const adopted = await admit(foreignStore, {
            expectedSessionId: sessionId,
            adoptOperation: owner.operation,
          });
          if (adopted.status !== "owned" || !adopted.databaseClaim) {
            throw new Error("Fixture requires physical-store adoption");
          }
          expect(adopted.databaseClaim.identity).not.toBe(owner.databaseClaim.identity);
          expect(snapshot.databaseClaim.isCurrent()).toBe(true);
        } finally {
          preparingOwner = false;
        }
      }
      owner.operation.updateSessionId(nextSessionId);
      owner.operation.complete();
      if (change === "cancelled") {
        controller.abort();
      } else if (change === "request-changed") {
        requestFailure = new Error("Original caller was retired during preparation");
        await closeOpenClawAgentDatabaseByPathAsync(storePath);
      }
      release.resolve();
      if (change === "cancelled") {
        await expect(pending).resolves.toEqual({ status: "skipped", reason: "aborted" });
        expect(reads).toBe(2);
      } else if (change === "request-changed") {
        // Caller refusal keeps precedence over a concurrent physical-store retirement.
        await expect(pending).rejects.toBe(requestFailure);
        expect(reads).toBe(2);
      } else {
        await expect(pending).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
      }
      expect(registry.replyRunRegistry.get(sessionKey)).toBeUndefined();
    } finally {
      release.resolve();
      owner?.operation.complete();
      const result = await pending.catch(() => undefined);
      complete(result);
    }
  },
);

it.for(
  (["writer", "active", "delivery"] as const).flatMap((wait) =>
    (["unchanged", "same-inode"] as const).map((replacement) => ({
      wait,
      replacement,
    })),
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
    const writerStarted = createDeferred();
    let owner: registry.ReplyOperation | undefined;
    let writer: Promise<void> | undefined;
    if (wait === "writer") {
      writer = runExclusiveSessionStoreWrite(storePath, async () => {
        writerStarted.resolve();
        await release.promise;
      });
      await writerStarted.promise;
    } else {
      const admitted = await admit(storePath);
      expect(admitted.status).toBe("owned");
      if (admitted.status !== "owned") {
        throw new Error("fixture requires an admitted blocking owner");
      }
      owner = admitted.operation;
      if (wait === "delivery") {
        owner.completeWithAfterClearBarrier(release.promise);
      }
    }
    const enteredWait = createDeferred();
    const load = sessionEntries.loadSessionEntryForAdmission;
    const loaded = vi
      .spyOn(sessionEntries, "loadSessionEntryForAdmission")
      .mockImplementation((...args) => {
        if (wait === "writer") {
          enteredWait.resolve();
        }
        return load(...args);
      });
    if (wait === "active") {
      const waitForIdle = registry.replyRunRegistry.waitForIdle.bind(registry.replyRunRegistry);
      vi.spyOn(registry.replyRunRegistry, "waitForIdle").mockImplementation((...args) => {
        enteredWait.resolve();
        return waitForIdle(...args);
      });
    } else if (wait === "delivery") {
      const waitForAdmission = registry.waitForReplyRunFollowupAdmission;
      vi.spyOn(registry, "waitForReplyRunFollowupAdmission").mockImplementation((...args) => {
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
      if (observed?.type !== "return") {
        throw new Error("fixture requires a completed authoritative row read");
      }
      const claim = (await observed.value).databaseClaim;
      expect(claim.isCurrent()).toBe(true);
      if (replacement !== "unchanged") {
        await closeOpenClawAgentDatabaseByPathAsync(storePath);
        expect(claim.isCurrent()).toBe(false);
      }
      owner?.complete();
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
      owner?.complete();
      release.resolve();
      controller.abort();
      const result = await pending.catch(() => undefined);
      complete(result);
      await writer;
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
      if (!signal) {
        throw new Error("Admission read requires its cancellation signal");
      }
      started.resolve(signal);
      return await new Promise<never>((_resolve, reject) => {
        const abort = () =>
          reject(
            signal.reason instanceof Error ? signal.reason : new Error("Admission read aborted"),
          );
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
        }
      });
    },
  );
  const upstream = new AbortController();
  const pending = Promise.allSettled([
    admitReplyTurn({
      storePath,
      sessionKey: interruptedKey,
      sessionId: "interrupted-read",
      kind: "visible",
      resetTriggered: false,
      upstreamAbortSignal: upstream.signal,
    }),
  ]);
  const target = { scope: storePath, identities: [interruptedKey] };
  try {
    const signal = await started.promise;
    const reason = new Error("Synthetic lifecycle interruption");
    const interrupted = startSessionWorkAdmissionInterruption({ ...target, reason });
    expect(signal.aborted).toBe(true);
    expect(upstream.signal.aborted).toBe(false);
    await interrupted.released;
    await runExclusiveSessionLifecycleMutation("patch", { ...target, run: async () => {} });
    expect(await pending).toMatchObject([{ status: "rejected", reason }]);
    expect(registry.replyRunRegistry.get(interruptedKey)).toBeUndefined();
  } finally {
    upstream.abort();
    await pending;
    await runExclusiveSessionLifecycleMutation("patch", { ...target, run: async () => {} });
  }
});
