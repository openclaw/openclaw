import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerTranscriptCommitParams } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";

const SESSION_ID = "session-worker-transcript";
const SESSION_KEY = "agent:main:worker-transcript";
const RUN_EPOCH = 7;
const IDENTITY: WorkerConnectionIdentity = {
  environmentId: "environment-a",
  credentialHash: ["credential", "hash", "a"].join("-"),
  bundleHash: "b".repeat(64),
  sessionId: SESSION_ID,
  runId: "run-worker-transcript",
  turnClaim: {
    sessionId: SESSION_ID,
    claimId: "claim-worker-transcript",
    runId: "run-worker-transcript",
    placementGeneration: 4,
    owner: { kind: "worker", environmentId: "environment-a", ownerEpoch: RUN_EPOCH },
  },
  ownerEpoch: RUN_EPOCH,
  rpcSetVersion: 1,
  protocolFeatures: ["worker-transcript-commit-v1"],
  credentialExpiresAtMs: 10_000,
};

function createRequest(): WorkerTranscriptCommitParams {
  return {
    runEpoch: RUN_EPOCH,
    seq: 1,
    baseLeafId: null,
    messages: [
      { role: "user", content: [{ type: "text", text: "Inspect the workspace" }], timestamp: 1 },
    ],
  };
}

async function createFixture() {
  // Every stateful fixture API must share the freshly imported owner's module generation.
  const [sessions, accessor, state, ledger, config, owner, agentState, reconcile] =
    await Promise.all([
      import("../../agents/sessions/session-manager.js"),
      import("../../config/sessions/session-accessor.js"),
      import("../../state/openclaw-state-db.js"),
      import("./transcript-commit-store.js"),
      import("../../config/io.js"),
      import("./transcript-commit.js"),
      import("../../state/openclaw-agent-db.js"),
      import("../../config/sessions/session-transcript-reconcile.js"),
    ]);
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "openclaw-transcript-load-"),
  );
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const storePath = path.join(root, "agents", "main", "sessions", "sessions.json");
  const cfg: OpenClawConfig = {
    agents: { list: [{ id: "main", default: true }] },
    session: { mainKey: "main", store: storePath },
  };
  await accessor.upsertSessionEntryCore(
    { agentId: "main", sessionKey: SESSION_KEY, storePath },
    { lifecycleRevision: "worker-original-revision", sessionId: SESSION_ID, updatedAt: 10 },
  );
  const target = await accessor.resolveSessionTranscriptRuntimeTarget({
    agentId: "main",
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    storePath,
  });
  const database = state.openOpenClawStateDatabase();
  const store = ledger.createWorkerTranscriptCommitStore({ database });
  return {
    store,
    committer: owner.createWorkerTranscriptCommitter({ getConfig: () => cfg, store }),
    readEntries: () => sessions.SessionManager.open(target).getEntries(),
    async cleanup() {
      config.clearRuntimeConfigSnapshot();
      await reconcile.waitForSessionTranscriptIndexReconcilesInStateDir(root);
      await agentState.closeOpenClawAgentDatabasesAsync(root);
      state.closeOpenClawStateDatabaseByPath(database.path);
      await fs.rm(root, { recursive: true, force: true });
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

  it.each(["current", "revoked", "loader-failed"] as const)(
    "loads before authority checks or reservations: %s",
    async (scenario) => {
      const loadStarted = createDeferredCore();
      const releaseLoad = createDeferredCore();
      const failure = new Error(`transcript runtime ${scenario}`);
      let revoked = false;
      vi.doMock("./transcript-commit.runtime.js", async (importOriginal) => {
        loadStarted.resolve();
        await releaseLoad.promise;
        if (scenario === "loader-failed") {
          throw failure;
        }
        return await importOriginal();
      });
      const begin = vi.spyOn(fixture.store, "begin");
      const assertCurrent = vi.fn((): undefined => {
        if (revoked) {
          throw failure;
        }
        return undefined;
      });
      const commit = fixture.committer.commit({
        identity: IDENTITY,
        request: createRequest(),
        assertCurrent,
      });
      const settled = commit.then(
        () => undefined,
        () => undefined,
      );
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
          if (scenario === "loader-failed") {
            await expect(commit).rejects.toMatchObject({ cause: failure });
          } else {
            await expect(commit).rejects.toBe(failure);
          }
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
        fixture.committer.commit({
          identity: reason === "session-not-attached" ? { ...IDENTITY, sessionId: null } : IDENTITY,
          request: {
            ...createRequest(),
            runEpoch: reason === "epoch-mismatch" ? RUN_EPOCH + 1 : RUN_EPOCH,
          },
          assertCurrent,
        }),
      ).resolves.toEqual({ ok: false, reason });
      expect(loadRuntime).not.toHaveBeenCalled();
      await expect(
        fixture.committer.commit({ identity: IDENTITY, request: createRequest(), assertCurrent }),
      ).rejects.toMatchObject({ cause: failure });
      expect(loadRuntime).toHaveBeenCalledOnce();
      expect(assertCurrent).not.toHaveBeenCalled();
      expect(begin).not.toHaveBeenCalled();
    },
  );
});
