import fs from "node:fs";
import path from "node:path";
import { afterEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  withAgentDeletion,
  type AgentDeletionOperation,
} from "../agents/agent-lifecycle-registry.js";
import { closeAuthProfileReadPool } from "../agents/auth-profiles/sqlite-read-pool.js";
import { purgeAgentSessionStoreEntries } from "../config/sessions/cleanup-service.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { purgeDeletedAgentSessionEntries } from "../config/sessions/session-agent-purge.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { assertNoOpenClawAgentDatabaseLeases } from "./openclaw-agent-db-lease.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "./openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "./openclaw-state-db.js";

export function useAgentDeletionFixture() {
  const dirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      vi.restoreAllMocks();
      await closeOpenClawAgentDatabasesAsync();
      closeAuthProfileReadPool();
      closeOpenClawAgentDatabasesForTest();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );
  return ({ shared = false, retained = false } = {}) => {
    const root = fs.realpathSync(dirs.make("agent-delete-cleanup-"));
    const env = { OPENCLAW_STATE_DIR: root };
    const options = { agentId: "worker", env };
    const database = openOpenClawAgentDatabase({
      ...options,
      ...(shared ? { agentId: "kept", path: path.join(root, "shared.sqlite") } : {}),
    });
    const target = { agentId: shared ? "kept" : "worker", path: database.path };
    const scope = {
      ...options,
      ...(shared ? { storePath: target.path } : {}),
      sessionKey: "agent:worker:main",
    };
    const write = (sessionId: string) =>
      replaceSessionEntrySync(scope, { sessionId, updatedAt: 1 });
    if (shared) {
      for (const agentId of ["worker", "kept"]) {
        replaceSessionEntrySync(
          { agentId, env, storePath: target.path, sessionKey: `agent:${agentId}:main` },
          { sessionId: agentId, updatedAt: Date.now() },
        );
      }
    } else {
      write("before");
    }
    if (!retained) {
      closeOpenClawAgentDatabaseByPath(database.path);
    }
    const entry = {
      agentId: "worker",
      agentDir: path.join(root, "agents/worker/agent"),
      workspaceDir: path.join(root, shared ? "workspace-worker" : "workspace"),
      sessionsDir: path.join(root, "agents/worker/sessions"),
    };
    const cfg = {
      agents: { entries: { worker: {}, kept: {} } },
      ...(shared ? { session: { store: target.path } } : {}),
    };
    const purgeStore = (
      deletion: Pick<AgentDeletionOperation, "runDatabaseCleanup">,
      config: OpenClawConfig = cfg,
    ) =>
      purgeAgentSessionStoreEntries(config, "worker", {
        env,
        runDatabaseCleanup: deletion.runDatabaseCleanup,
      });
    return {
      root,
      env,
      options,
      target,
      entry,
      cfg,
      scope,
      write,
      purgeStore,
      open: () => openOpenClawAgentDatabase(options),
      resource: (close = async () => {}) =>
        registerOpenClawAgentDatabaseAsyncResource({ ...target, revoke: () => {}, close }),
      read: () => loadSessionEntryReadOnly(scope)?.sessionId,
      assertDrained: () => assertNoOpenClawAgentDatabaseLeases("worker", { env }),
      replaceJournal: () =>
        beginAgentDeletionJournal(
          { ...entry, operationId: "replacement", deleteFiles: true },
          { env },
        ),
      purge: (store = target) =>
        purgeDeletedAgentSessionEntries({
          cfg: { ...cfg, session: { store: store.path, maintenance: { mode: "warn" } } },
          agentId: "worker",
          storeAgentId: store.agentId,
          storePath: store.path,
          env,
        }),
      withDeletion: <T>(run: (deletion: AgentDeletionOperation) => Promise<T>) =>
        withAgentDeletion("worker", async (begin) => run(await begin(entry)), { env }),
      async retain() {
        await closeOpenClawAgentDatabasesAsync();
        const retainedTarget = { ...target, env };
        return {
          target: retainedTarget,
          retained: captureOpenClawAgentDatabaseExecution(retainedTarget),
        };
      },
      sharedStore() {
        const sharedOptions = {
          ...options,
          agentId: "kept",
          path: path.join(root, "shared.sqlite"),
        };
        const sharedDatabase = openOpenClawAgentDatabase(sharedOptions);
        const workerScope = {
          ...options,
          storePath: sharedDatabase.path,
          sessionKey: "agent:worker:shared",
        };
        const keptScope = { ...workerScope, agentId: "kept", sessionKey: "agent:kept:shared" };
        replaceSessionEntrySync(workerScope, { sessionId: "remove", updatedAt: Date.now() });
        replaceSessionEntrySync(keptScope, { sessionId: "keep", updatedAt: Date.now() });
        const sharedConfig = { ...cfg, session: { store: sharedDatabase.path } };
        return {
          sharedOptions,
          shared: sharedDatabase,
          workerScope,
          keptScope,
          purge: (deletion: Pick<AgentDeletionOperation, "runDatabaseCleanup">) =>
            purgeStore(deletion, sharedConfig),
        };
      },
    };
  };
}
