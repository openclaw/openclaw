import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { openFixtureReceiptChannel } from "../../test/helpers/fixture-receipts.js";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { saveAuthProfileStore } from "../agents/auth-profiles.js";
import { modelDefinition } from "../agents/model-auth.fixtures.test-support.js";
import { listConfiguredOwnerInputs } from "../agents/prepared-model-runtime.configured.js";
import {
  getPreparedModelRuntimeSnapshot,
  markPreparedModelRuntimeSnapshotsStale,
  refreshPreparedModelRuntimeSnapshots,
} from "../agents/prepared-model-runtime.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveStateDir } from "../config/paths.js";
import {
  getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { sessionTranscriptIndexNeedsReconcile } from "../config/sessions/session-transcript-index.js";
import { waitForSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readSqliteDatabaseCleanClose,
  retireSqliteDatabaseAdmissionForPath,
  revokeSqliteDatabaseAdmissionsForPath,
} from "../infra/sqlite-database-admission.js";
import { sqliteWorkerPreloadEnv } from "../infra/sqlite-worker-preload.test-support.js";
import * as workerCpu from "../infra/worker-cpu.js";
import * as logging from "../logging/subsystem.js";
import { runExec } from "../process/exec.js";
import * as spawnBroker from "../process/spawn-broker/context.js";
import {
  activateSecretsRuntimeSnapshotWithSource,
  getActiveSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  AgentDatabaseAdmissionError,
  listAgentDatabaseAdmissionRefusals,
  readAgentDatabaseAdmissionRefusal,
} from "../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { unregisterOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { assertOpenClawDatabasesReady } from "../state/openclaw-database-preflight.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
// Keep cold module evaluation outside the lifecycle and RPC behavior deadlines.
import { loadGatewayTestConfig } from "./test-helpers.config-runtime.js";
import "./server-methods/chat-send-external-entry.js";
import { gatewayReplyMock, testState } from "./test-helpers.runtime-state.js";
import {
  connectWebchatClient,
  installGatewayTestHooks,
  rpcReq,
  startConnectedServerWithClient,
  startTestGatewayServer,
} from "./test-helpers.server.js";

installGatewayTestHooks();
let pendingFixtureCleanup: Promise<void> | undefined;
afterEach(async () => {
  try {
    await pendingFixtureCleanup;
  } finally {
    pendingFixtureCleanup = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

// The Gateway shares this process's event loop. A keep-alive probe can reuse a
// socket that Undici still considers live, then a synchronous startup stall lets
// the server's idle timer destroy it before the request is read (ECONNRESET).
function probeGateway(port: number, pathname: "/healthz" | "/readyz") {
  return fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { Connection: "close" } });
}

async function closeDatabases() {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
}

function expectPreparedModel(agentId: string) {
  const input = listConfiguredOwnerInputs(getRuntimeConfig(), undefined, true).find(
    (entry) => entry.agentId === agentId,
  );
  expect(input).toBeDefined();
  expect(input && getPreparedModelRuntimeSnapshot(input)).toBeDefined();
}

function pauseIntegrityInspection(params: {
  root: string;
  pathname: string;
  pausePreparation?: boolean;
  pauseSchema?: boolean;
  preparationReceiptBroadcastName?: string;
}) {
  const releasePath = path.join(params.root, "release-inspection");
  const enteredPath = path.join(params.root, "inspection-entered");
  const preparationReleasePath = `${releasePath}-preparation`;
  const preparationEnteredPath = `${enteredPath}-preparation`;
  const preload = path.join(params.root, "pause-inspection.cjs");
  fs.writeFileSync(
    preload,
    `
const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { BroadcastChannel, isMainThread, threadId } = require('node:worker_threads');
const receiptBroadcastName = ${JSON.stringify(params.preparationReceiptBroadcastName)};
const receipts = !isMainThread && receiptBroadcastName ? new BroadcastChannel(receiptBroadcastName) : undefined;
receipts?.unref();
const pathname = ${JSON.stringify(fs.realpathSync.native(params.pathname))};
const preparation = ${params.pausePreparation === true} && (!isMainThread || process.argv[1]?.includes('sqlite-integrity.worker'));
const marker = preparation ? ${JSON.stringify(preparationEnteredPath)} : ${JSON.stringify(enteredPath)};
const release = preparation ? ${JSON.stringify(preparationReleasePath)} : ${JSON.stringify(releasePath)};
let startupInspection = false;
// A preload listener starts IPC delivery before the worker registers its handler.
const emit = process.emit;
process.emit = function(event, ...args) {
  if (event === 'message') {
    const request = args[0];
    startupInspection = request?.type === 'inspect' && request.input?.requireStartupMigrationReadiness === true;
  }
  return emit.call(this, event, ...args);
};
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql) {
  const location = this.location();
  const selected = ${params.pauseSchema === true} && !preparation ? startupInspection && /PRAGMA user_version/i.test(sql) : /integrity_check/.test(sql);
  if (selected && location && fs.realpathSync.native(location) === pathname) {
    // Existence is the shutdown gate; never expose a truncated PID.
    const pendingMarker = marker + '.' + process.pid + '.tmp';
    if (!isMainThread) fs.writeFileSync(marker + '.thread', String(threadId));
    fs.writeFileSync(pendingMarker, String(process.pid));
    fs.renameSync(pendingMarker, marker);
    receipts?.postMessage({ source: marker, line: 'entered' });
    const pause = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 60000;
    while (!fs.existsSync(release)) {
      if (Date.now() > deadline) throw new Error('inspection fixture pause expired');
      Atomics.wait(pause, 0, 0, 10);
    }
  }
  return prepare.call(this, sql);
};
`,
  );
  const env = sqliteWorkerPreloadEnv(preload);
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  return {
    env,
    releasePath,
    enteredPath,
    preparationReleasePath,
    preparationEnteredPath,
  };
}

it.for([
  { outcome: "recover", agentId: "worker" },
  { outcome: "corrupt", agentId: "worker" },
  { outcome: "physical-corrupt", agentId: "main" },
  { outcome: "shutdown", agentId: "worker" },
  { outcome: "fast", agentId: "worker" },
  { outcome: "recover", agentId: "main" },
  { outcome: "corrupt", agentId: "main" },
  { outcome: "startup-failure", agentId: "worker" },
  { outcome: "superseded", agentId: "worker" },
  { outcome: "shutdown-preparation", agentId: "worker" },
  { outcome: "handoff", agentId: "main" },
] as const)(
  "applies startup admission while $agentId follows its $outcome lifecycle",
  async ({ outcome, agentId }, { signal }) => {
    const checkHostJournalReads = outcome === "recover";
    let recoverySource: OpenClawConfig | undefined;
    const nativeBroker = process.platform === "linux" && !process.versions.bun;
    const brokerExpected =
      nativeBroker ||
      (process.platform !== "win32" &&
        !process.versions.bun &&
        ["recover", "shutdown", "shutdown-preparation"].includes(outcome));
    testState.agentsConfig = { ownership: "explicit", entries: { main: {}, worker: {} } };
    testState.agentConfig = { systemAgent: { agentId: "main" } };
    const recoverySecret = "synthetic-startup-recovery-secret";
    if (outcome === "recover") {
      vi.stubEnv("OPENCLAW_TEST_RECOVERY_SECRET", recoverySecret);
    }
    const env = { ...process.env };
    const cfg = loadGatewayTestConfig();
    setRuntimeConfigSnapshot(cfg);
    const root = resolveStateDir(env);
    const scope = {
      agentId,
      env,
      sessionId: "retained",
      sessionKey: `agent:${agentId}:retained`,
    };
    const healthyAgentId = agentId === "main" ? "worker" : "main";
    const healthyPath = openOpenClawAgentDatabase({ agentId: healthyAgentId, env }).path;
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        { eventId: "retained-message", message: { role: "user", content: "retained history" } },
      ],
      touchSessionEntry: false,
    });
    await waitForSessionTranscriptIndexReconcile(scope);
    const database = openOpenClawAgentDatabase(scope);
    if (outcome === "recover") {
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "anthropic:startup-recovery": {
              type: "api_key",
              provider: "anthropic",
              keyRef: { source: "env", provider: "default", id: "OPENCLAW_TEST_RECOVERY_SECRET" },
            },
          },
        },
        path.dirname(database.path),
      );
    }
    if (outcome !== "fast") {
      database.db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1").run();
    }
    const agentPath = database.path;
    // Join worker reader retirement before changing journal mode or replacing files.
    await closeDatabases();
    // A new process reloads sealed facts instead of retaining the test reset's revoked cells.
    for (const pathname of [healthyPath, agentPath]) {
      retireSqliteDatabaseAdmissionForPath(pathname);
    }
    if (outcome !== "fast") {
      // Unclean external mutation requires the writable owner's integrity gate.
      revokeSqliteDatabaseAdmissionsForPath(agentPath);
      const raw = new DatabaseSync(agentPath);
      try {
        raw.exec("PRAGMA journal_mode=DELETE");
        if (outcome === "corrupt") {
          raw.exec(
            "PRAGMA foreign_keys=OFF; CREATE TABLE broken_parent(id INTEGER PRIMARY KEY); CREATE TABLE broken_child(parent_id REFERENCES broken_parent(id)); INSERT INTO broken_child VALUES (42)",
          );
        }
      } finally {
        raw.close();
      }
    }
    if (outcome === "physical-corrupt") {
      fs.writeFileSync(agentPath, "not a SQLite database");
    } else if (outcome === "shutdown-preparation") {
      // A configured, unregistered store needs cold write admission before the
      // canonical-validation worker can lend its own verification receipt.
      unregisterOpenClawAgentDatabase({ agentId, path: agentPath, env });
      await closeStateDatabaseForTest();
    }
    const agentBytes = fs.readFileSync(agentPath);
    const refusal = () => readAgentDatabaseAdmissionRefusal(agentId, { env });
    const waitForRecovery = () =>
      vi.waitFor(() => expect(refusal()).toBeUndefined(), { timeout: 10000 });
    const handoffReceipts =
      outcome === "handoff" || outcome === "shutdown-preparation"
        ? await openFixtureReceiptChannel()
        : undefined;
    if (handoffReceipts) {
      onTestFinished(() => handoffReceipts.close());
    }
    const paused = outcome !== "corrupt" && outcome !== "physical-corrupt" && outcome !== "fast";
    const pause = paused
      ? pauseIntegrityInspection({
          root,
          pathname: agentPath,
          pausePreparation: outcome === "shutdown-preparation" || outcome === "handoff",
          pauseSchema: outcome !== "handoff",
          preparationReceiptBroadcastName: handoffReceipts?.broadcastName,
        })
      : undefined;
    const releasePath = pause?.releasePath ?? path.join(root, "release-inspection");
    const enteredPath = pause?.enteredPath ?? path.join(root, "inspection-entered");
    Object.assign(env, pause?.env);
    const preparationRelease = createDeferredCore();
    const preparationEntered = createDeferredCore();
    const maintenanceCompleted = createDeferredCore();
    const dispatched = createDeferredCore();
    let sessionPrepared = false;
    let preparationParent: number | undefined;
    let brokerPid: number | undefined;
    let inspectionAliveAtBrokerClose: boolean | undefined;
    let preparationCancelled = false;
    const nativeWorkers = new Map<number, Worker>();
    const createWorker = workerCpu.createCpuTrackedWorker;
    vi.spyOn(workerCpu, "createCpuTrackedWorker").mockImplementation((...args) => {
      const worker = createWorker(...args);
      nativeWorkers.set(worker.threadId, worker);
      return worker;
    });
    const inspectionAlive = (marker: string) => {
      if (fs.existsSync(`${marker}.thread`)) {
        const worker = nativeWorkers.get(Number(fs.readFileSync(`${marker}.thread`, "utf8")));
        if (!worker) {
          throw new Error("Startup inspection Worker was not observed");
        }
        return worker.threadId !== -1;
      }
      try {
        process.kill(Number(fs.readFileSync(marker, "utf8")), 0);
        return true;
      } catch {
        return false;
      }
    };
    const startBroker = spawnBroker.startGatewaySpawnBroker;
    vi.spyOn(spawnBroker, "startGatewaySpawnBroker").mockImplementation(async (options) => {
      const broker = await startBroker(options);
      brokerPid = broker?.pid;
      if (broker && (outcome === "shutdown" || outcome === "shutdown-preparation")) {
        const close = broker.close.bind(broker);
        vi.spyOn(broker, "close").mockImplementation(async () => {
          try {
            const marker = outcome === "shutdown" ? enteredPath : pause!.preparationEnteredPath;
            // Failed preparation may never create its marker; preserve the primary error.
            if (fs.existsSync(marker)) {
              inspectionAliveAtBrokerClose = inspectionAlive(marker);
            }
          } finally {
            await close();
          }
        });
      }
      return broker;
    });
    if (outcome === "recover" || outcome === "superseded") {
      const session = await import("./server-startup-session-migration.js");
      const prepare = session.prepareGatewayStartupSessions;
      vi.spyOn(session, "prepareGatewayStartupSessions").mockImplementation(async (params) => {
        const databases = await prepare(params);
        if (params.agentIds?.has(agentId)) {
          sessionPrepared = true;
          if (outcome === "recover") {
            const result = await runExec(process.execPath, ["-e", "console.log(process.ppid)"], {
              logOutput: false,
            });
            preparationParent = Number(result.stdout);
            preparationEntered.resolve();
            await preparationRelease.promise;
          }
        }
        return databases;
      });
      const maintain = session.runGatewaySessionStartupMaintenance;
      vi.spyOn(session, "runGatewaySessionStartupMaintenance").mockImplementation(
        async (params) => {
          await maintain(params);
          if (params.databases.some(({ database: prepared }) => prepared.agentId === agentId)) {
            maintenanceCompleted.resolve();
          }
        },
      );
    }
    if (outcome === "superseded") {
      const model = await import("../agents/prepared-model-runtime.js");
      const refresh = model.refreshPreparedModelRuntimeSnapshots;
      vi.spyOn(model, "refreshPreparedModelRuntimeSnapshots").mockImplementation(
        async (config, options) => {
          await refresh(config, options);
          if (options?.agentIds?.has(agentId)) {
            markPreparedModelRuntimeSnapshotsStale("same-config publication superseded", {
              agentIds: new Set([agentId]),
            });
          }
        },
      );
    }
    let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
    let inspectionSettled: Promise<unknown> | undefined;
    let waitForHealthyAgent = (): Promise<void> | undefined => undefined;
    let suppliedBroker: Awaited<ReturnType<typeof spawnBroker.startGatewaySpawnBroker>>;
    let unadoptedPortClaim: TestPortClaim | undefined;
    let chatClient: Awaited<ReturnType<typeof connectWebchatClient>> | undefined;
    try {
      if (outcome === "startup-failure") {
        const startupFailure = new Error("startup stopped before Gateway adoption");
        await expect(
          withAgentDatabaseStartupAdmission(async () => {
            await assertOpenClawDatabasesReady({ env, operation: "gateway-startup", config: cfg });
            await vi.waitFor(() => expect(fs.existsSync(enteredPath)).toBe(true));
            throw startupFailure;
          }),
        ).rejects.toBe(startupFailure);
        expect(fs.existsSync(releasePath)).toBe(false);
        const pid = Number(fs.readFileSync(enteredPath, "utf8"));
        expect(() => process.kill(pid, 0)).toThrow();
        return;
      }
      const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
      unadoptedPortClaim = portClaim;
      const port = portClaim.port;
      const startup = withAgentDatabaseStartupAdmission(async (admission) => {
        if (outcome === "shutdown-preparation") {
          admission.signal.addEventListener(
            "abort",
            () => {
              preparationCancelled = true;
              fs.writeFileSync(pause!.preparationReleasePath, "owner cancelled");
            },
            { once: true },
          );
        }
        await assertOpenClawDatabasesReady({ env, operation: "gateway-startup", config: cfg });
        inspectionSettled = admission.pendingPreparation;
        waitForHealthyAgent = () =>
          admission.waitForAgentPreparation(healthyAgentId, { env, signal, forWrite: true });
        // Other Unix hosts exercise the broker context without pretending their OS is Linux.
        if (brokerExpected && !nativeBroker) {
          suppliedBroker = await spawnBroker.startGatewaySpawnBroker({
            onReady: () => {},
            onStartupFailure: (message) => {
              throw new Error(message);
            },
          });
        }
        return spawnBroker.runWithSpawnBroker(suppliedBroker, () => {
          unadoptedPortClaim = undefined;
          return startTestGatewayServer(portClaim, {
            bind: "loopback",
            auth: { mode: "none" },
          });
        });
      }).then((started) => {
        server = started;
        return started;
      });
      if (agentId === "main" && outcome === "physical-corrupt") {
        await expect(startup).rejects.toMatchObject({
          name: "AgentDatabaseAdmissionError",
          refusal: { agentId, code: "agent-database-inspection-failed", paths: [agentPath] },
        });
        expect(fs.readFileSync(agentPath)).toEqual(agentBytes);
        await expect(probeGateway(port, "/readyz")).rejects.toThrow();
        return;
      }
      server = await startup;
      await server.startupSettled;
      if (brokerExpected) {
        expect(brokerPid).toBeTypeOf("number");
      }
      expect((await probeGateway(port, "/healthz")).status).toBe(200);
      if (outcome === "corrupt") {
        // Gateway startup can settle before background integrity inspection does.
        await withinTest(inspectionSettled ?? Promise.resolve(), signal);
        expect(refusal()).toMatchObject({
          code: "agent-database-inspection-failed",
          repairHint: expect.stringContaining(
            `openclaw doctor --session-sqlite recover --session-sqlite-agent ${agentId}`,
          ),
        });
        expect(() => openOpenClawAgentDatabase(scope)).toThrow(AgentDatabaseAdmissionError);
        expect((await probeGateway(port, "/readyz")).status).toBe(agentId === "main" ? 503 : 200);
        return;
      }
      // Sidecar settlement can precede the unpaused sibling's database admission.
      await waitForHealthyAgent();
      expect(readAgentDatabaseAdmissionRefusal(healthyAgentId, { env })).toBeUndefined();
      const readiness = await probeGateway(port, "/readyz");
      expect(readiness.status).toBe(agentId === "main" && paused ? 503 : 200);
      if (agentId === "main" && paused) {
        await expect(readiness.json()).resolves.toMatchObject({
          ready: false,
          failing: ["agent-database:main"],
          agentDatabases: [refusal()],
        });
      }
      const chatParams = {
        sessionKey: `agent:${agentId}:startup-dispatch`,
        message: "Synthetic startup dispatch",
        idempotencyKey: `startup-dispatch-${agentId}`,
      };
      if (paused) {
        expect(refusal()).toMatchObject({
          code: "agent-database-inspection-pending",
        });
        expect(() => openOpenClawAgentDatabase(scope)).toThrow(AgentDatabaseAdmissionError);
        if (outcome === "handoff") {
          // Old startup blocks in full-file preflight before claiming its writable lease.
          expect(fs.existsSync(enteredPath)).toBe(false);
          const preparationMarker = pause!.preparationEnteredPath;
          await withinTest(handoffReceipts!.waitFor(preparationMarker, "entered"), signal);
          expect(fs.existsSync(preparationMarker)).toBe(true);
        } else {
          await vi.waitFor(() => expect(fs.existsSync(enteredPath)).toBe(true));
        }
      }
      if (outcome === "recover") {
        // Full post-attach model preparation can republish auth-store containers;
        // assert the bootstrap fence before that independent publication.
        const snapshot = getActiveSecretsRuntimeSnapshot();
        expect(snapshot?.authStores.some((entry) => entry.databasePath === agentPath)).toBe(false);
        expect(snapshot?.degradedOwners?.some((owner) => owner.paths.includes(agentPath))).toBe(
          false,
        );
      }
      if (agentId === "main") {
        // Minimal Gateway skips the real post-bind model phase; exercise that owner
        // while the default agent is still unavailable to protect inherited auth.
        await refreshPreparedModelRuntimeSnapshots(getRuntimeConfig(), {
          gatewayLifecycle: true,
          catalogMode: "static",
          allowGatewaySubagentBinding: true,
        });
        expectPreparedModel(healthyAgentId);
      }
      const hostJournalRead = createDeferredCore();
      let hostJournalReads = 0;
      if (checkHostJournalReads) {
        observeHostDataSql((sql) => {
          if (sql.includes("agent_deletion_journal")) {
            hostJournalReads++;
            hostJournalRead.resolve();
          }
        });
      }
      if (outcome === "handoff") {
        expect(fs.existsSync(releasePath)).toBe(false);
        fs.writeFileSync(pause!.preparationReleasePath, "resume");
        await waitForRecovery();
      } else if (outcome === "shutdown-preparation") {
        fs.writeFileSync(releasePath, "resume");
        const preparationEnteredPath = pause!.preparationEnteredPath;
        await withinTest(
          awaitGateBeforeSettlement(
            handoffReceipts!.waitFor(preparationEnteredPath, "entered"),
            inspectionSettled!,
            "startup preparation settled before entering its shutdown gate",
          ),
          signal,
        );
        expect(fs.existsSync(preparationEnteredPath)).toBe(true);
        expect(preparationCancelled).toBe(false);
        expect(fs.existsSync(pause!.preparationReleasePath)).toBe(false);
        await server.close();
        await suppliedBroker?.close();
        if (brokerExpected) {
          expect(inspectionAliveAtBrokerClose).toBe(false);
          expect(() => process.kill(brokerPid!, 0)).toThrow();
        }
        expect(preparationCancelled).toBe(true);
        expect(fs.readFileSync(pause!.preparationReleasePath, "utf8")).toBe("owner cancelled");
        expect(inspectionAlive(preparationEnteredPath)).toBe(false);
        expect(fs.readFileSync(agentPath)).toEqual(agentBytes);
      } else if (outcome === "recover" || outcome === "superseded") {
        if (outcome === "recover") {
          chatClient = await connectWebchatClient({ port });
          gatewayReplyMock.mockImplementationOnce(async () => {
            dispatched.resolve();
            return { text: "Synthetic startup reply" };
          });
          expect(await rpcReq(chatClient, "chat.send", chatParams)).toMatchObject({
            ok: false,
            error: {
              code: "UNAVAILABLE",
              retryable: true,
              details: { reason: "startup-sidecars", method: "chat.send" },
            },
          });
          expect(gatewayReplyMock).not.toHaveBeenCalled();
          const active = getActiveSecretsRuntimeSnapshot()!;
          const source = structuredClone(active.sourceConfig);
          source.models = {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                models: [
                  modelDefinition("gpt-5.6-sol", {
                    name: "GPT-5.6",
                    api: "openai-responses",
                    agentRuntime: { id: "openclaw" },
                    contextWindow: 128000,
                    maxTokens: 4096,
                  }),
                ],
              },
            },
          };
          const runtime = structuredClone(source);
          recoverySource = source;
          runtime.models!.providers!.openai!.models[0]!.compat = {
            supportsTemperature: false,
            codeMode: "preferred",
          };
          // Startup keeps catalog defaults in the secrets input, separate from authored config.
          activateSecretsRuntimeSnapshotWithSource(
            { ...active, config: runtime, sourceConfig: runtime },
            source,
          );
        }
        fs.writeFileSync(releasePath, "resume");
        if (outcome === "superseded") {
          await vi.waitFor(
            () =>
              expect(refusal()).toMatchObject({
                code: "agent-database-inspection-failed",
                reason: expect.stringContaining("model preparation has not published"),
              }),
            { timeout: 10000 },
          );
          expect(sessionPrepared).toBe(false);
          return;
        }
        await withinTest(
          Promise.race([
            preparationEntered.promise,
            hostJournalRead.promise.then(() => expect(hostJournalReads).toBe(0)),
          ]),
          signal,
        );
        expect(preparationParent).toBe(brokerExpected ? brokerPid : process.pid);
        expect(refusal()).toMatchObject({
          code: "agent-database-inspection-pending",
        });
        preparationRelease.resolve();
        await waitForRecovery();
        await withinTest(maintenanceCompleted.promise, signal);
        expect(
          withOpenClawAgentDatabaseReadOnly(
            ({ db }) => sessionTranscriptIndexNeedsReconcile(db, scope.sessionId),
            scope,
          ),
        ).toEqual({ found: true, value: false });
        expectPreparedModel(agentId);
        expect(getRuntimeConfig().models?.providers?.openai?.models[0]?.compat).toEqual({
          supportsTemperature: false,
          codeMode: "preferred",
        });
        expect(getRuntimeConfigSourceSnapshot()).toEqual(recoverySource);
        const snapshot = getActiveSecretsRuntimeSnapshot();
        expect(
          snapshot?.authStores.find((entry) => entry.databasePath === agentPath)?.store.profiles[
            "anthropic:startup-recovery"
          ],
        ).toMatchObject({ key: recoverySecret });
        expect(snapshot?.degradedOwners?.some((owner) => owner.paths.includes(agentPath))).toBe(
          false,
        );
        expect((await probeGateway(port, "/readyz")).status).toBe(200);
        expect(await rpcReq(chatClient!, "chat.send", chatParams)).toMatchObject({ ok: true });
        await withinTest(dispatched.promise, signal);
        if (checkHostJournalReads) {
          expect(hostJournalReads).toBe(0);
        }
      } else if (outcome === "shutdown") {
        await server.close();
        await suppliedBroker?.close();
        if (brokerExpected) {
          expect(inspectionAliveAtBrokerClose).toBe(false);
          expect(() => process.kill(brokerPid!, 0)).toThrow();
        }
        expect(fs.existsSync(releasePath)).toBe(false);
        const pid = Number(fs.readFileSync(enteredPath, "utf8"));
        expect(() => process.kill(pid, 0)).toThrow();
      } else {
        expect(refusal()).toBeUndefined();
      }
    } finally {
      pendingFixtureCleanup = (async () => {
        preparationRelease.resolve();
        fs.writeFileSync(releasePath, "resume");
        if (pause) {
          fs.writeFileSync(pause.preparationReleasePath, "resume");
        }
        try {
          if (chatClient) {
            await closeGatewayTestWebSocket(chatClient);
          }
          await server?.close();
        } finally {
          try {
            await suppliedBroker?.close();
          } finally {
            await unadoptedPortClaim?.release();
          }
        }
      })();
      await pendingFixtureCleanup;
    }
  },
);

it("admits an unsealed fleet including reserved system agents while skipping an unowned leftover", async ({
  signal,
}) => {
  testState.agentsConfig = {
    ownership: "explicit",
    entries: { "worker-a": {}, "worker-b": {}, main: {}, absent: {} },
  };
  testState.agentConfig = { systemAgent: { agentId: "main" } };
  const env = { ...process.env };
  const cfg = loadGatewayTestConfig();
  const agentIds = ["worker-a", "worker-b", "main", "openclaw", "crestodian"];
  const paths = agentIds.map((agentId) => openOpenClawAgentDatabase({ agentId, env }).path);
  const stalePaths = agentIds.map(
    (agentId) =>
      openOpenClawAgentDatabase({
        agentId,
        path: path.join(resolveStateDir(env), `(multiple).${agentId}.sqlite`),
        env,
      }).path,
  );
  const leftover = openOpenClawAgentDatabase({ agentId: "unowned", env }).path;
  await closeDatabases();
  for (const pathname of [...paths, leftover]) {
    expect(readSqliteDatabaseCleanClose(pathname)).toBe(true);
    revokeSqliteDatabaseAdmissionsForPath(pathname);
  }
  fs.writeFileSync(leftover, "unconfigured leftover must not be inspected or repaired");
  const leftoverBytes = fs.readFileSync(leftover);
  const staleBytes = stalePaths.map((pathname) => fs.readFileSync(pathname));
  for (const pathname of paths) {
    const database = new DatabaseSync(pathname);
    try {
      // Index repair retains late publication, after all native generations have opened.
      database.exec("PRAGMA journal_mode=DELETE; DROP INDEX idx_agent_session_nodes_active");
    } finally {
      database.close();
    }
  }
  const warnings = vi.fn();
  const createLogger = logging.createSubsystemLogger;
  vi.spyOn(logging, "createSubsystemLogger").mockImplementation((name) => {
    const logger = createLogger(name);
    return name === "state/agent-admission" ? { ...logger, warn: warnings } : logger;
  });
  const openings: string[] = [];
  let activeOpenings = 0;
  let peakOpenings = 0;
  const openingEntered = agentIds.map(() => createDeferredCore());
  const openingReleases = new Map(agentIds.map((id) => [id, createDeferredCore()]));
  const openedGenerations = new Map<string, string | undefined>();
  const publishedGenerations = new Map<string, string | undefined>();
  const allOpened = createDeferredCore();
  const readGeneration = async (agentId: string, pathname: string) => {
    const execution = captureOpenClawAgentDatabaseExecution({ agentId, path: pathname, env });
    try {
      return execution.capturePreparedGenerationClaim()?.incarnation;
    } finally {
      await execution.release();
    }
  };
  const admitted = new Set<string>();
  const allAdmitted = createDeferredCore();
  const unsubscribe = sessionChanges.subscribe((change) => {
    if ("all" in change && typeof change.scope === "object" && change.scope.topology) {
      const id = change.scope.agentId;
      if (
        id &&
        agentIds.includes(id) &&
        !listAgentDatabaseAdmissionRefusals({ env }).some((refusal) => refusal.agentId === id)
      ) {
        admitted.add(id);
        if (admitted.size === agentIds.length) {
          allAdmitted.resolve();
        }
      }
    }
  });
  let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
  try {
    const started = await withAgentDatabaseStartupAdmission(async (admission) => {
      const activate = admission.activate.bind(admission);
      vi.spyOn(admission, "activate").mockImplementation((activation) =>
        activate({
          ...activation,
          openAgent: async (input) => {
            activeOpenings += 1;
            peakOpenings = Math.max(peakOpenings, activeOpenings);
            openings.push(input.agentId);
            openingEntered[openings.length - 1]!.resolve();
            try {
              await withinTest(openingReleases.get(input.agentId)!.promise, signal);
              const prepared = await activation.openAgent(input);
              openedGenerations.set(
                input.agentId,
                await readGeneration(input.agentId, input.paths[0]!),
              );
              if (openedGenerations.size === agentIds.length) {
                allOpened.resolve();
              }
              return prepared;
            } finally {
              activeOpenings -= 1;
            }
          },
          publishAgent: async (input) => {
            // Five completed opens exceed the owner's four-idle-executor limit.
            await withinTest(allOpened.promise, signal);
            await activation.publishAgent(input);
            publishedGenerations.set(
              input.agentId,
              await readGeneration(input.agentId, input.paths[0]!),
            );
          },
        }),
      );
      await assertOpenClawDatabasesReady({ env, operation: "gateway-startup", config: cfg });
      const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
      return {
        port: portClaim.port,
        server: await startTestGatewayServer(portClaim, {
          bind: "loopback",
          auth: { mode: "none" },
        }),
      };
    });
    server = started.server;
    await server.startupSettled;
    expect((await probeGateway(started.port, "/healthz")).status).toBe(200);
    expect((await probeGateway(started.port, "/readyz")).status).toBe(503);
    for (const agentId of agentIds) {
      expect(readAgentDatabaseAdmissionRefusal(agentId, { env })).toMatchObject({
        code: "agent-database-inspection-pending",
        paths: [paths[agentIds.indexOf(agentId)]],
      });
    }
    expect(readAgentDatabaseAdmissionRefusal("absent", { env })).toBeUndefined();
    const absentOptions = { agentId: "absent", env };
    expect(fs.existsSync(resolveOpenClawAgentSqlitePath(absentOptions))).toBe(false);
    expect(openOpenClawAgentDatabase(absentOptions).agentId).toBe("absent");
    expect(readAgentDatabaseAdmissionRefusal("unowned", { env })).toBeUndefined();
    expect(fs.readFileSync(leftover)).toEqual(leftoverBytes);
    await withinTest(openingEntered[1]!.promise, signal);
    expect(openings).toHaveLength(2);
    expect((await probeGateway(started.port, "/readyz")).status).toBe(503);
    openingReleases.get(openings[0]!)!.resolve();
    await withinTest(openingEntered[2]!.promise, signal);
    expect(openings).toHaveLength(3);
    for (const release of openingReleases.values()) {
      release.resolve();
    }
    await withinTest(allAdmitted.promise, signal);
    expect(peakOpenings).toBe(2);
    expect([...openedGenerations.values()]).not.toContain(undefined);
    expect(new Set([...openedGenerations.values(), ...publishedGenerations.values()]).size).toBe(
      agentIds.length,
    );
    expect(publishedGenerations).toEqual(openedGenerations);
    expect(warnings).toHaveBeenCalledWith(
      `Skipped ${leftover} (agent unowned): database is not a configured target; run openclaw doctor to inspect retained data.`,
    );
    for (const [index, pathname] of stalePaths.entries()) {
      expect(fs.readFileSync(pathname)).toEqual(staleBytes[index]);
      expect(warnings).toHaveBeenCalledWith(
        `Skipped ${pathname} (agent ${agentIds[index]}): database is not a configured target; run openclaw doctor to inspect retained data.`,
      );
    }
    for (const agentId of agentIds) {
      expect(readAgentDatabaseAdmissionRefusal(agentId, { env })).toBeUndefined();
    }
    expect(readAgentDatabaseAdmissionRefusal("unowned", { env })).toBeUndefined();
    expect(fs.readFileSync(leftover)).toEqual(leftoverBytes);
    expect((await probeGateway(started.port, "/readyz")).status).toBe(200);
  } finally {
    unsubscribe();
    allOpened.resolve();
    for (const release of openingReleases.values()) {
      release.resolve();
    }
    await server?.close();
  }
});

it("reports history in a skipped unconfigured agent store as not found", async () => {
  const sessionKey = "agent:gemini:acp:skipped-history";
  setRuntimeConfigSnapshot(loadGatewayTestConfig());
  await upsertSessionEntryCore(
    { agentId: "gemini", sessionKey },
    { sessionId: "skipped-history", updatedAt: 1 },
  );
  await closeDatabases();
  testState.agentsConfig = { ownership: "explicit", entries: { main: {} } };
  testState.agentConfig = { systemAgent: { agentId: "main" } };
  const env = { ...process.env };
  const started = await withAgentDatabaseStartupAdmission(async () => {
    await assertOpenClawDatabasesReady({
      env,
      operation: "gateway-startup",
      config: loadGatewayTestConfig(),
    });
    return await startConnectedServerWithClient();
  });
  try {
    await started.server.startupSettled;
    const listed = await rpcReq<{ sessions: Array<{ key: string }> }>(started.ws, "sessions.list", {
      limit: 1000,
    });
    expect(listed.payload?.sessions.map((row) => row.key)).not.toContain(sessionKey);
    for (const method of ["chat.history", "chat.startup"]) {
      expect(await rpcReq(started.ws, method, { sessionKey })).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST", message: `Session "${sessionKey}" was not found.` },
      });
    }
  } finally {
    started.ws.close();
    await started.server.close();
    started.envSnapshot.restore();
  }
});
