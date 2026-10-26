import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterAll, expect, onTestFinished, test, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import * as archiveWorker from "../config/sessions/session-accessor.sqlite-archive.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.sqlite-entry.js";
import { ensureSessionEntrySync } from "../config/sessions/session-accessor.sqlite-initial-entry.js";
import { runSqliteSessionReclamation } from "../config/sessions/session-accessor.sqlite-reclamation-run.js";
import { createLifecycleArtifactReclamationPlan } from "../config/sessions/session-accessor.sqlite-reclamation.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import * as agentDb from "../state/openclaw-agent-db.js";
import * as stateCache from "../state/openclaw-state-db-cache.js";
import * as stateDb from "../state/openclaw-state-db.js";
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
    await agentDb.closeOpenClawAgentDatabasesAsync(externalRoot);
    agentDb.closeOpenClawAgentDatabasesForTest(externalRoot);
  }
  if (externalStatePath) {
    await stateDb.closeOpenClawStateDatabaseByPathAsync(externalStatePath);
  }
});
installGatewayTestHooks();

test("joins a direct history projection's accepted read before retiring the Gateway home", async () => {
  setRuntimeConfigSnapshot({});
  const scope = { agentId: "main", sessionKey: "agent:main:fixture-history" };
  const shared = stateDb.openOpenClawStateDatabase();
  const context = createDirectChatContext();
  await initializeSessionReadContext(context);
  const projection = getSessionRowProjection(context)!;
  await projection.ensureMaterialized();
  const entered = createDeferred();
  const release = createDeferred();
  const captureSource = stateReader.captureOpenClawStateReadSource;
  const reader = vi.spyOn(stateReader, "captureOpenClawStateReadSource").mockImplementation(() => {
    const source = captureSource();
    return {
      own: (close) => source.own(close),
      createTransport(command) {
        const transport = source.createTransport(command);
        if (command.type !== "sessionRows.sharedFacts") {
          return transport;
        }
        return {
          startValidateFresh: (...args) => transport.startValidateFresh(...args),
          startClose: () => transport.startClose(),
          async startRead(...args) {
            const reply = await transport.startRead(...args);
            entered.resolve();
            await release.promise;
            return reply;
          },
        };
      },
    };
  });
  const dispose = projection.dispose;
  const disposing = vi.spyOn(projection, "dispose").mockImplementation(() => {
    dispose();
    release.resolve();
  });
  // Keep the native borrower until fixture disposal; failed hooks must still release it.
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
  // A new identity forces a native read instead of reusing an absent-ACP receipt.
  ensureSessionEntrySync(scope, { sessionId: "fixture-history", updatedAt: 1 });
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
  await agentDb.closeOpenClawAgentDatabasesAsync(externalRoot);
  using spawned = vi.spyOn(archiveWorker, "createSqliteTranscriptArchiveWorker");
  await expect(runSqliteSessionReclamation({ plan })).resolves.toMatchObject({
    kind: "lifecycle-artifacts",
    value: { removedEntries: 1 },
  });
  expect(spawned).toHaveBeenCalledOnce();
  const [result] = spawned.mock.results;
  const worker = result?.type === "return" ? result.value : undefined;
  expect(worker?.threadId).toBeGreaterThan(0);
  expect(fs.existsSync(sharedStatePath)).toBe(true);
  const otherStateDir = path.join(externalRoot, "other-state");
  externalStatePath = stateDb.openOpenClawStateDatabase({
    env: { OPENCLAW_STATE_DIR: otherStateDir },
  }).path;
  const identity = stateCache.captureOpenClawStateDatabaseReadAdmission(sharedStatePath).identity;
  const sharedState = stateDb.openOpenClawStateDatabase({ env });
  let retained = stateCache.retainOpenClawStateDatabaseForIndependentRead(sharedState.path);
  assert(retained, "Expected the fixture shared-state owner to be open");
  const closedOwners: Array<string | undefined> = [];
  const unregister = stateCache.registerOpenClawStateDatabaseAsyncResource({
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
      expect(worker?.threadId).toBe(-1);
      expect(fs.existsSync(sharedStatePath)).toBe(false);
      expect(closedOwners[0]).toBe(identity.key);
    } finally {
      retained?.release();
      unregister();
    }
  });
});
