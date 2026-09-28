import fs from "node:fs";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { afterAll, expect, onTestFinished, test, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as archiveWorker from "../config/sessions/session-accessor.sqlite-archive.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.sqlite-entry.js";
import { ensureSessionEntrySync } from "../config/sessions/session-accessor.sqlite-initial-entry.js";
import {
  createLifecycleArtifactReclamationPlan,
  runSqliteSessionReclamation,
} from "../config/sessions/session-accessor.sqlite-reclamation.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  registerOpenClawStateDatabaseAsyncResource,
  retainOpenClawStateDatabaseForIndependentRead,
} from "../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateReader from "../state/openclaw-state-read-worker.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { initializeSessionReadContext } from "./server-methods/sessions-read-cache.test-support.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { installGatewayTestHooks } from "./test-helpers.server.js";

const roots = useAutoCleanupTempDirTracker(afterAll);
let externalRoot: string | undefined;
let externalStatePath: string | undefined;
afterAll(async () => {
  if (externalRoot) {
    await closeOpenClawAgentDatabasesAsync(externalRoot);
    closeOpenClawAgentDatabasesForTest(externalRoot);
  }
  if (externalStatePath) {
    await closeOpenClawStateDatabaseByPathAsync(externalStatePath);
  }
});
installGatewayTestHooks();

test("joins a direct history projection's accepted read before retiring the Gateway home", async () => {
  const scope = { agentId: "main", sessionKey: "agent:main:fixture-history" };
  ensureSessionEntrySync(scope, { sessionId: "fixture-history", updatedAt: 1 });
  const shared = openOpenClawStateDatabase();
  const context = createDirectChatContext();
  await initializeSessionReadContext(context);
  const projection = getSessionRowProjection(context)!;
  await projection.ensureMaterialized();
  const entered = createDeferred();
  const release = createDeferred();
  const createTransport = stateReader.createOpenClawStateReadTransport;
  const reader = vi
    .spyOn(stateReader, "createOpenClawStateReadTransport")
    .mockImplementation((command) => {
      const transport = createTransport(command);
      if (command.type !== "acpSessions.metadata") {
        return transport;
      }
      return {
        ...transport,
        async read(...args) {
          const reply = await transport.read(...args);
          entered.resolve();
          await release.promise;
          return reply;
        },
      };
    });
  const dispose = projection.dispose;
  const disposing = vi.spyOn(projection, "dispose").mockImplementation(() => {
    dispose();
    release.resolve();
  });
  // Returning leaves a real native borrower pending until fixture disposal starts.
  // Always release it after a failed hook so the proof itself cannot leak custody.
  onTestFinished(async () => {
    release.resolve();
    try {
      await projection.ensureMaterialized();
      expect(shared.db.isOpen).toBe(false);
    } finally {
      reader.mockRestore();
      disposing.mockRestore();
    }
  });
  sessionChanges.emit(scope);
  await withTestTimeout(entered.promise, 5_000, "Projection did not retain its shared-state read");
  expect(shared.db.isOpen).toBe(true);
});

test("joins external-store workers before deleting their Gateway lease coordinator", async () => {
  externalRoot = fs.realpathSync(roots.make("gateway-external-store-"));
  const env = { OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR };
  const sharedStatePath = resolveOpenClawStateSqlitePath(env);
  const databaseOptions = {
    agentId: "main",
    env,
    path: path.join(externalRoot, "agent.sqlite"),
  };
  const scope = {
    agentId: "main",
    env,
    storePath: databaseOptions.path,
    sessionKey: "agent:main:fixture-reclamation",
  };
  ensureSessionEntrySync(scope, { sessionId: "fixture-reclamation", updatedAt: 1 });
  const plan = createLifecycleArtifactReclamationPlan({
    agentId: "main",
    databaseOptions,
    entries: [{ sessionKey: scope.sessionKey, expectedEntry: loadSessionEntryReadOnly(scope) }],
    materializedPlans: [],
  });
  // Seed handles belong to this external fixture; the next operation retains only its Worker.
  await closeOpenClawAgentDatabasesAsync(externalRoot);
  const workers: Worker[] = [];
  const create = archiveWorker.createSqliteTranscriptArchiveWorker;
  const spawned = vi
    .spyOn(archiveWorker, "createSqliteTranscriptArchiveWorker")
    .mockImplementation((data) => {
      const worker = create(data);
      workers.push(worker);
      return worker;
    });
  try {
    await expect(
      runSqliteSessionReclamation({ plan, forceInProcess: false }),
    ).resolves.toMatchObject({
      kind: "lifecycle-artifacts",
      value: { removedEntries: 1 },
    });
  } finally {
    spawned.mockRestore();
  }
  expect(workers).toHaveLength(1);
  expect(workers[0]?.threadId).toBeGreaterThan(0);
  expect(fs.existsSync(sharedStatePath)).toBe(true);
  const otherStateDir = path.join(externalRoot, "other-state");
  const otherState = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: otherStateDir } });
  externalStatePath = otherState.path;
  const identity = captureOpenClawStateDatabaseReadAdmission(sharedStatePath).identity;
  const sharedState = openOpenClawStateDatabase({ env });
  let retained = retainOpenClawStateDatabaseForIndependentRead(sharedState.path);
  if (!retained) {
    throw new Error("Expected the fixture shared-state owner to be open");
  }
  const closedOwners: Array<string | undefined> = [];
  const unregister = registerOpenClawStateDatabaseAsyncResource({
    close: async (closedIdentity) => {
      closedOwners.push(closedIdentity?.key);
      if (closedIdentity?.key === identity.key) {
        retained?.release();
        retained = undefined;
      }
    },
  });
  setTestEnvValue("OPENCLAW_STATE_DIR", otherStateDir);
  onTestFinished(() => {
    try {
      expect(workers[0]?.threadId).toBe(-1);
      expect(fs.existsSync(sharedStatePath)).toBe(false);
      expect(closedOwners[0]).toBe(identity.key);
    } finally {
      retained?.release();
      unregister();
    }
  });
});
