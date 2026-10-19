import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  withAgentDeletion,
  type AgentDeletionOperation,
} from "../agents/agent-lifecycle-registry.js";
import { purgeAgentSessionStoreEntries } from "../config/sessions/cleanup-service.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { withSessionEntryWorker } from "../config/sessions/session-accessor.sqlite-replacement-worker.js";
import { purgeDeletedAgentSessionEntries } from "../config/sessions/session-agent-purge.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesAsync as closeAgentDbs,
  openOpenClawAgentDatabase as openAgentDb,
} from "./openclaw-agent-db.js";
import * as native from "./openclaw-agent-execution-native.js";
import * as execution from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeAgentDbs();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

async function fixture(shared: boolean) {
  const root = fs.realpathSync(tempDirs.make("delete-straggling-write-"));
  const env = { OPENCLAW_STATE_DIR: root };
  const storeAgentId = shared ? "kept" : "worker";
  const database = openAgentDb({
    agentId: storeAgentId,
    env,
    ...(shared ? { path: path.join(root, "shared.sqlite") } : {}),
  });
  const target = { agentId: storeAgentId, path: database.path, env };
  const cfg = {
    agents: { entries: { worker: {}, kept: {} } },
    ...(shared ? { session: { store: target.path } } : {}),
  };
  for (const agentId of shared ? ["worker", "kept"] : ["worker"]) {
    replaceSessionEntrySync(
      { agentId, env, storePath: target.path, sessionKey: `agent:${agentId}:main` },
      { sessionId: shared ? agentId : "before", updatedAt: shared ? Date.now() : 1 },
    );
  }
  await closeAgentDbs();
  const retained = execution.captureOpenClawAgentDatabaseExecution(target);
  const entry = {
    agentId: "worker",
    agentDir: path.join(root, "agents/worker/agent"),
    workspaceDir: path.join(root, shared ? "workspace-worker" : "workspace"),
    sessionsDir: path.join(root, "agents/worker/sessions"),
  };
  return {
    target,
    cfg,
    env,
    retained,
    withDeletion: <T>(run: (deletion: AgentDeletionOperation) => Promise<T>) =>
      withAgentDeletion("worker", async (begin) => run(await begin(entry)), { env }),
  };
}

it("preserves a surviving shared-store executor across another agent's deletion", async () => {
  const f = await fixture(true);
  const { target, cfg, env, retained } = f;
  const purged = createDeferredCore();
  const survivorUsed = createDeferredCore();
  const read = (agentId: string) =>
    withSessionEntryWorker(
      target,
      undefined,
      () => retained.assertCurrent(),
      async (owner, source) => {
        await owner.prepare(source);
        const result = await owner.runExisting(source, (worker) =>
          worker.execute({
            type: "session.entry.read",
            input: { sessionKey: `agent:${agentId}:main` },
          }),
        );
        return result?.entries[0]?.entry;
      },
      undefined,
      retained,
    );
  try {
    expect(await read("kept")).toMatchObject({ sessionId: "kept" });
    const deleting = f.withDeletion(async (deletion) => {
      await expect(
        purgeAgentSessionStoreEntries(cfg, "worker", {
          env,
          runDatabaseCleanup: (store, run) =>
            deletion.runDatabaseCleanup(store, async () => {
              const result = await run();
              purged.resolve();
              await survivorUsed.promise;
              return result;
            }),
        }),
      ).resolves.toBe(false);
      expect(await read("worker")).toBeUndefined();
      expect(await read("kept")).toMatchObject({ sessionId: "kept" });
      await deletion.finish();
    });
    try {
      await awaitGateBeforeSettlement(
        purged.promise,
        deleting,
        "shared-store purge did not finish",
      );
      expect(await read("kept")).toMatchObject({ sessionId: "kept" });
      const fresh = execution.captureOpenClawAgentDatabaseExecution(target);
      await fresh.release();
    } finally {
      survivorUsed.resolve();
      await deleting;
    }
    expect(await read("kept")).toMatchObject({ sessionId: "kept" });
  } finally {
    survivorUsed.resolve();
    await retained.release();
  }
});

it("keeps purge's native generation alive when a retained ordinary borrower is refused", async () => {
  const f = await fixture(false);
  const { target, cfg, env, retained } = f;
  const agentId = "worker";
  const prepared = createDeferredCore();
  const resumePurge = createDeferredCore();
  const closing = createDeferredCore();
  const create = native.createAgentDatabaseNativeGeneration;
  vi.spyOn(native, "createAgentDatabaseNativeGeneration").mockImplementationOnce((...args) => {
    const generation = create(...args);
    let operations = 0;
    return {
      ...generation,
      run(source, operation, ...request) {
        return generation.run(
          source,
          async (scope) => {
            if (++operations === 2) {
              prepared.resolve();
              await resumePurge.promise;
            }
            return operation(scope);
          },
          ...request,
        );
      },
      close() {
        closing.resolve();
        return generation.close();
      },
    };
  });
  try {
    await f.withDeletion(async (deletion) => {
      const purging = deletion.runDatabaseCleanup(target, () =>
        purgeDeletedAgentSessionEntries({
          cfg,
          agentId,
          storeAgentId: agentId,
          storePath: target.path,
          env,
        }),
      );
      const purged = expect(purging).resolves.toBeUndefined();
      try {
        await awaitGateBeforeSettlement(
          prepared.promise,
          purging,
          "purge did not prepare its native generation",
        );
        const staleOperation = vi.fn(async () => undefined);
        const refused = expect(
          retained.runExisting(
            {
              assertCurrent() {},
              createAdmission() {
                throw new Error("Refused borrower reached native admission");
              },
            },
            staleOperation,
            { retireNativeOnFailure: true },
          ),
        ).rejects.toThrow(/active deletion cleanup|execution admission is closed/);
        await Promise.race([closing.promise, refused]);
        resumePurge.resolve();
        await refused;
        expect(staleOperation).not.toHaveBeenCalled();
      } finally {
        resumePurge.resolve();
        await purged;
      }
    });
  } finally {
    resumePurge.resolve();
    await retained.release();
  }
  using reader = openNodeSqliteDatabase(target.path, { readOnly: true });
  expect(reader.prepare("SELECT session_key FROM session_nodes").all()).toEqual([]);
});
