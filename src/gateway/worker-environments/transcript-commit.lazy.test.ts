import "../../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerTranscriptCommitParams } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { WorkerTranscriptCommitApplication } from "./transcript-commit.js";

const RUN_EPOCH = 7;

function createRequest(): WorkerTranscriptCommitParams {
  return {
    runEpoch: RUN_EPOCH,
    seq: 1,
    baseLeafId: null,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }],
  };
}

async function createFixture() {
  // Every stateful fixture API must share the freshly imported owner's module generation.
  const [sessions, fixtures, config] = await Promise.all([
    import("../../agents/sessions/session-manager.js"),
    import("./transcript-commit.fixture.test-support.js"),
    import("../../config/io.js"),
  ]);
  let cfg: OpenClawConfig = {};
  const f = await fixtures.createTranscriptCommitFixture(() => cfg);
  cfg = { ...f.cfg, session: { mainKey: "main", store: f.storePath } };
  return {
    store: f.ledgerStore,
    identity: f.owner.identity,
    commit: (overrides: Partial<Parameters<WorkerTranscriptCommitApplication>[0]> = {}) =>
      f.committer.commit({
        ...f.owner,
        sessionTarget: f.sessionTarget,
        request: createRequest(),
        ...overrides,
      }),
    readEntries: () => sessions.SessionManager.open(f.sessionTarget).getEntries(),
    async cleanup() {
      config.clearRuntimeConfigSnapshot();
      await f.close();
    },
  };
}

describe("worker transcript runtime loading", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;

  beforeEach(async () => {
    vi.resetModules();
    fixture = await createFixture();
  });

  afterEach(async () => {
    try {
      vi.doUnmock("./transcript-commit.runtime.js");
      vi.restoreAllMocks();
      await fixture.cleanup();
    } finally {
      vi.unstubAllEnvs();
    }
    vi.resetModules();
  });

  it("awaits the pending receipt before transcript effects and terminal persistence before replying", async () => {
    const began = createDeferredCore();
    const releaseBegin = createDeferredCore();
    const completing = createDeferredCore();
    const releaseComplete = createDeferredCore();
    const begin = fixture.store.begin.bind(fixture.store);
    const complete = fixture.store.complete.bind(fixture.store);
    vi.spyOn(fixture.store, "begin").mockImplementation(async (...args) => {
      const result = await begin(...args);
      began.resolve();
      await releaseBegin.promise;
      return result;
    });
    vi.spyOn(fixture.store, "complete").mockImplementation(async (...args) => {
      completing.resolve();
      await releaseComplete.promise;
      return await complete(...args);
    });
    let replied = false;
    const pending = fixture.commit().then((result) => {
      replied = true;
      return result;
    });
    try {
      await awaitGateBeforeSettlement(began.promise, pending, "commit settled before begin");
      expect(fixture.readEntries()).toEqual([]);
      expect(replied).toBe(false);
      releaseBegin.resolve();
      await awaitGateBeforeSettlement(
        completing.promise,
        pending,
        "commit settled before completion",
      );
      expect(fixture.readEntries()).toHaveLength(1);
      expect(replied).toBe(false);
      releaseComplete.resolve();
      await expect(pending).resolves.toMatchObject({ ok: true });
    } finally {
      releaseBegin.resolve();
      releaseComplete.resolve();
      await pending;
    }
  });

  it.each(["current", "revoked"] as const)(
    "loads before authority checks or reservations: %s",
    async (scenario) => {
      const loadStarted = createDeferredCore();
      const releaseLoad = createDeferredCore();
      const failure = new Error(`transcript runtime ${scenario}`);
      let revoked = false;
      vi.doMock("./transcript-commit.runtime.js", async (importOriginal) => {
        loadStarted.resolve();
        await releaseLoad.promise;
        return await importOriginal();
      });
      const begin = vi.spyOn(fixture.store, "begin");
      const assertCurrent = vi.fn((): undefined => {
        if (revoked) {
          throw failure;
        }
      });
      const commit = fixture.commit({ assertCurrent });
      const settled = commit.catch(() => undefined);
      try {
        expect(
          await Promise.race([
            loadStarted.promise.then(() => "loading"),
            settled.then(() => "settled"),
          ]),
        ).toBe("loading");
        expect(assertCurrent).not.toHaveBeenCalled();
        expect(begin).not.toHaveBeenCalled();
        revoked = scenario === "revoked";
        releaseLoad.resolve();
        if (scenario === "current") {
          await expect(commit).resolves.toMatchObject({ ok: true });
          expect(begin).toHaveBeenCalledOnce();
          expect(fixture.readEntries()).toHaveLength(1);
        } else {
          await expect(commit).rejects.toBe(failure);
          expect(begin).not.toHaveBeenCalled();
          expect(fixture.readEntries()).toEqual([]);
        }
      } finally {
        releaseLoad.resolve();
        await settled;
      }
    },
  );

  it.each(["session-not-attached", "epoch-mismatch"] as const)(
    "rejects %s without loading the runtime",
    async (reason) => {
      const failure = new Error("runtime load reached");
      const loadRuntime = vi.fn(() => {
        throw failure;
      });
      vi.doMock("./transcript-commit.runtime.js", loadRuntime);
      const begin = vi.spyOn(fixture.store, "begin");
      const assertCurrent = vi.fn(() => undefined);
      await expect(
        fixture.commit({
          identity:
            reason === "session-not-attached"
              ? { ...fixture.identity, sessionId: null }
              : fixture.identity,
          request: {
            ...createRequest(),
            runEpoch: reason === "epoch-mismatch" ? RUN_EPOCH + 1 : RUN_EPOCH,
          },
          assertCurrent,
        }),
      ).resolves.toEqual({ ok: false, reason });
      expect(loadRuntime).not.toHaveBeenCalled();
      await expect(fixture.commit({ assertCurrent })).rejects.toMatchObject({ cause: failure });
      expect(loadRuntime).toHaveBeenCalledOnce();
      expect(assertCurrent).not.toHaveBeenCalled();
      expect(begin).not.toHaveBeenCalled();
    },
  );
});
