import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { saveAuthProfileStore } from "../agents/auth-profiles.js";
import { listConfiguredOwnerInputs } from "../agents/prepared-model-runtime.configured.js";
import {
  getPreparedModelRuntimeSnapshot,
  markPreparedModelRuntimeSnapshotsStale,
  refreshPreparedModelRuntimeSnapshots,
} from "../agents/prepared-model-runtime.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveStateDir } from "../config/paths.js";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { sessionTranscriptIndexNeedsReconcile } from "../config/sessions/session-transcript-index.js";
import { waitForSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import * as inspection from "../infra/sqlite-readonly-worker.js";
import { sqliteWorkerPreloadEnv } from "../infra/sqlite-worker-preload.test-support.js";
import { runExec } from "../process/exec.js";
import * as spawnBroker from "../process/spawn-broker/context.js";
import { getActiveSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { readAgentDatabaseAdmissionRefusal } from "../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import { unregisterOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { assertOpenClawDatabasesReady } from "../state/openclaw-database-preflight.js";
import { clearOpenClawAgentIntegrityVerification } from "../state/openclaw-quarantine-store.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import { loadGatewayTestConfig } from "./test-helpers.config-runtime.js";
import { testState } from "./test-helpers.runtime-state.js";
import { installGatewayTestHooks, startTestGatewayServer } from "./test-helpers.server.js";

installGatewayTestHooks();
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function pauseIntegrityInspections(params: {
  root: string;
  paths: string[];
  pausePaths?: string[];
  pausePreparation?: boolean;
}) {
  const releasePath = path.join(params.root, "release-inspection");
  const enteredPaths = params.paths.map((_, index) =>
    path.join(params.root, `inspection-entered-${index}`),
  );
  const preparationReleasePath = `${releasePath}-preparation`;
  const releasePaths = params.paths.map((_, index) => `${releasePath}-${index}`);
  const preparationReleasePaths = releasePaths.map((pathname) => `${pathname}-preparation`);
  const preparationEnteredPaths = enteredPaths.map((pathname) => `${pathname}-preparation`);
  const pausedPaths = params.pausePaths ?? params.paths;
  const preload = path.join(params.root, "pause-inspection.cjs");
  fs.writeFileSync(
    preload,
    `
const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const paths = ${JSON.stringify(params.paths.map((pathname) => fs.realpathSync.native(pathname)))};
const paused = ${JSON.stringify(params.paths.map((pathname) => pausedPaths.includes(pathname)))};
const preparation = ${params.pausePreparation === true} && process.argv[1]?.includes('sqlite-integrity.worker');
const markers = preparation ? ${JSON.stringify(preparationEnteredPaths)} : ${JSON.stringify(enteredPaths)};
const release = preparation ? ${JSON.stringify(preparationReleasePath)} : ${JSON.stringify(releasePath)};
const releases = preparation ? ${JSON.stringify(preparationReleasePaths)} : ${JSON.stringify(releasePaths)};
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql) {
  const location = this.location();
  const index = /integrity_check/.test(sql) && location ? paths.indexOf(fs.realpathSync.native(location)) : -1;
  if (index >= 0) {
    fs.writeFileSync(markers[index], String(process.pid));
    const pause = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 60000;
    while (paused[index] && !fs.existsSync(release) && !fs.existsSync(releases[index])) {
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
  const readBudget = inspection.readSqliteInspectionBudget;
  vi.spyOn(inspection, "readSqliteInspectionBudget").mockImplementation(
    (operation, pathname, size) => {
      const budget = readBudget(operation, pathname, size);
      return pausedPaths.includes(pathname) ? { ...budget, timeoutMs: 1 } : budget;
    },
  );
  return {
    env,
    releasePath,
    releasePaths,
    enteredPaths,
    preparationReleasePath,
    preparationEnteredPaths,
  };
}

it.each([
  { outcome: "recover", agentId: "worker" },
  { outcome: "corrupt", agentId: "worker" },
  { outcome: "physical-corrupt", agentId: "worker" },
  { outcome: "physical-corrupt", agentId: "main" },
  { outcome: "shutdown", agentId: "worker" },
  { outcome: "fast", agentId: "worker" },
  { outcome: "recover", agentId: "main" },
  { outcome: "corrupt", agentId: "main" },
  { outcome: "startup-failure", agentId: "worker" },
  { outcome: "superseded", agentId: "worker" },
  { outcome: "shutdown-preparation", agentId: "worker" },
] as const)(
  "applies startup admission while $agentId follows its $outcome lifecycle",
  async ({ outcome, agentId }) => {
    const nativeBroker = process.platform === "linux" && !process.versions.bun;
    const brokerExpected =
      nativeBroker ||
      (process.platform !== "win32" &&
        !process.versions.bun &&
        ["recover", "shutdown", "shutdown-preparation"].includes(outcome));
    testState.agentsConfig = { entries: { main: { default: true }, worker: {} } };
    const recoverySecret = "synthetic-startup-recovery-secret";
    if (outcome === "recover") {
      vi.stubEnv("OPENCLAW_TEST_RECOVERY_SECRET", recoverySecret);
    }
    const env = { ...process.env };
    const cfg = loadGatewayTestConfig();
    const root = resolveStateDir(env);
    const scope = {
      agentId,
      env,
      sessionId: "retained",
      sessionKey: `agent:${agentId}:retained`,
    };
    const healthyAgentId = agentId === "main" ? "worker" : "main";
    openOpenClawAgentDatabase({ agentId: healthyAgentId, env });
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
    database.db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1").run();
    const agentPath = database.path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    // These fixtures exercise full startup inspection after unclean external mutation.
    clearOpenClawAgentIntegrityVerification(agentPath, env);
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
    if (outcome === "physical-corrupt") {
      fs.writeFileSync(agentPath, "not a SQLite database");
    } else if (outcome === "shutdown-preparation") {
      // A configured, unregistered store needs cold write admission before the
      // canonical-validation worker can lend its own verification receipt.
      unregisterOpenClawAgentDatabase({ agentId, path: agentPath, env });
      closeOpenClawStateDatabaseForTest();
    }
    const agentBytes = fs.readFileSync(agentPath);
    const paused = outcome !== "corrupt" && outcome !== "physical-corrupt" && outcome !== "fast";
    const pause = paused
      ? pauseIntegrityInspections({
          root,
          paths: [agentPath],
          pausePreparation: outcome === "shutdown-preparation",
        })
      : undefined;
    const releasePath = pause?.releasePath ?? path.join(root, "release-inspection");
    const enteredPath = pause?.enteredPaths[0] ?? path.join(root, "inspection-entered-0");
    Object.assign(env, pause?.env);
    const preparationRelease = createDeferredCore();
    const preparationEntered = createDeferredCore();
    let sessionPrepared = false;
    let preparationParent: number | undefined;
    let brokerPid: number | undefined;
    let inspectionAliveAtBrokerClose: boolean | undefined;
    const startBroker = spawnBroker.startGatewaySpawnBroker;
    vi.spyOn(spawnBroker, "startGatewaySpawnBroker").mockImplementation(async (options) => {
      const broker = await startBroker(options);
      brokerPid = broker?.pid;
      if (broker && (outcome === "shutdown" || outcome === "shutdown-preparation")) {
        const close = broker.close.bind(broker);
        vi.spyOn(broker, "close").mockImplementation(async () => {
          try {
            const marker =
              outcome === "shutdown" ? enteredPath : pause!.preparationEnteredPaths[0]!;
            const pid = Number(fs.readFileSync(marker, "utf8"));
            try {
              process.kill(pid, 0);
              inspectionAliveAtBrokerClose = true;
            } catch {
              inspectionAliveAtBrokerClose = false;
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
      const migrate = session.runStartupSessionMigration;
      vi.spyOn(session, "runStartupSessionMigration").mockImplementation(async (params) => {
        await migrate(params);
        if (params.agentIds?.has(agentId)) {
          if (outcome === "recover") {
            const result = await runExec(process.execPath, ["-e", "console.log(process.ppid)"], {
              logOutput: false,
            });
            preparationParent = Number(result.stdout);
          }
          sessionPrepared = true;
          preparationEntered.resolve();
          await preparationRelease.promise;
        }
      });
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
    let suppliedBroker: Awaited<ReturnType<typeof spawnBroker.startGatewaySpawnBroker>>;
    let unadoptedPortClaim: TestPortClaim | undefined;
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
      const startup = withAgentDatabaseStartupAdmission(async () => {
        await assertOpenClawDatabasesReady({ env, operation: "gateway-startup", config: cfg });
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
          return startTestGatewayServer(portClaim, { bind: "loopback", auth: { mode: "none" } });
        });
      }).then((started) => {
        server = started;
        return started;
      });
      if (agentId === "main" && (outcome === "corrupt" || outcome === "physical-corrupt")) {
        await expect(startup).rejects.toMatchObject({
          name: "AgentDatabaseAdmissionError",
          refusal: { agentId, code: "agent-database-inspection-failed", paths: [agentPath] },
        });
        expect(fs.readFileSync(agentPath)).toEqual(agentBytes);
        await expect(fetch(`http://127.0.0.1:${port}/readyz`)).rejects.toThrow();
        return;
      }
      server = await startup;
      await server.startupSettled;
      if (brokerExpected) {
        expect(brokerPid).toBeTypeOf("number");
      }
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
      const readiness = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(readiness.status).toBe(agentId === "main" && paused ? 503 : 200);
      if (agentId === "main" && paused) {
        await expect(readiness.json()).resolves.toMatchObject({
          ready: false,
          failing: ["agent-database:main"],
          agentDatabases: [readAgentDatabaseAdmissionRefusal(agentId, { env })],
        });
      }
      expect(readAgentDatabaseAdmissionRefusal(healthyAgentId, { env })).toBeUndefined();
      if (paused) {
        expect(readAgentDatabaseAdmissionRefusal(agentId, { env })).toMatchObject({
          code: "agent-database-inspection-pending",
        });
        await vi.waitFor(() => expect(fs.existsSync(enteredPath)).toBe(true));
      }
      if (outcome === "recover") {
        const snapshot = getActiveSecretsRuntimeSnapshot();
        expect(snapshot?.authStores.some((entry) => entry.databasePath === agentPath)).toBe(false);
        expect(snapshot?.degradedOwners?.some((owner) => owner.paths.includes(agentPath))).toBe(
          true,
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
        const healthyInput = listConfiguredOwnerInputs(getRuntimeConfig(), undefined, true).find(
          (entry) => entry.agentId === healthyAgentId,
        );
        expect(healthyInput).toBeDefined();
        expect(healthyInput && getPreparedModelRuntimeSnapshot(healthyInput)).toBeDefined();
      }
      if (outcome === "shutdown-preparation") {
        fs.writeFileSync(releasePath, "resume");
        const preparationEnteredPath = pause!.preparationEnteredPaths[0]!;
        await vi.waitFor(() => expect(fs.existsSync(preparationEnteredPath)).toBe(true), {
          timeout: 10000,
        });
        await server.close();
        await suppliedBroker?.close();
        if (brokerExpected) {
          expect(inspectionAliveAtBrokerClose).toBe(false);
          expect(() => process.kill(brokerPid!, 0)).toThrow();
        }
        expect(fs.existsSync(pause!.preparationReleasePath)).toBe(false);
        const pid = Number(fs.readFileSync(preparationEnteredPath, "utf8"));
        expect(() => process.kill(pid, 0)).toThrow();
      } else if (outcome === "recover" || outcome === "superseded") {
        fs.writeFileSync(releasePath, "resume");
        await preparationEntered.promise;
        expect(sessionPrepared).toBe(true);
        if (outcome === "recover") {
          expect(preparationParent).toBe(brokerExpected ? brokerPid : process.pid);
        }
        expect(readAgentDatabaseAdmissionRefusal(agentId, { env })).toMatchObject({
          code: "agent-database-inspection-pending",
        });
        preparationRelease.resolve();
        if (outcome === "superseded") {
          await vi.waitFor(
            () =>
              expect(readAgentDatabaseAdmissionRefusal(agentId, { env })).toMatchObject({
                code: "agent-database-inspection-failed",
                reason: expect.stringContaining("model preparation has not published"),
              }),
            { timeout: 10000 },
          );
          return;
        }
        await vi.waitFor(
          () => expect(readAgentDatabaseAdmissionRefusal(agentId, { env })).toBeUndefined(),
          { timeout: 10000 },
        );
        expect(
          sessionTranscriptIndexNeedsReconcile(
            openOpenClawAgentDatabase(scope).db,
            scope.sessionId,
          ),
        ).toBe(false);
        const input = listConfiguredOwnerInputs(getRuntimeConfig(), undefined, true).find(
          (entry) => entry.agentId === agentId,
        );
        expect(input).toBeDefined();
        expect(input && getPreparedModelRuntimeSnapshot(input)).toBeDefined();
        const snapshot = getActiveSecretsRuntimeSnapshot();
        expect(
          snapshot?.authStores.find((entry) => entry.databasePath === agentPath)?.store.profiles[
            "anthropic:startup-recovery"
          ],
        ).toMatchObject({ key: recoverySecret });
        expect(snapshot?.degradedOwners?.some((owner) => owner.paths.includes(agentPath))).toBe(
          false,
        );
        expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
      } else if (outcome === "corrupt" || outcome === "physical-corrupt") {
        expect(readAgentDatabaseAdmissionRefusal(agentId, { env })).toMatchObject({
          code: "agent-database-inspection-failed",
          repairHint: expect.stringContaining("doctor --fix"),
        });
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
        expect(readAgentDatabaseAdmissionRefusal(agentId, { env })).toBeUndefined();
      }
    } finally {
      preparationRelease.resolve();
      fs.writeFileSync(releasePath, "resume");
      if (pause) {
        fs.writeFileSync(pause.preparationReleasePath, "resume");
      }
      try {
        await server?.close();
      } finally {
        try {
          await suppliedBroker?.close();
        } finally {
          await unadoptedPortClaim?.release();
        }
      }
    }
  },
);

it("recovers queued agents after both inspection slots expire without refusing an absent database", async () => {
  testState.agentsConfig = {
    entries: { a: {}, b: {}, main: { default: true }, absent: {} },
  };
  const env = { ...process.env };
  const cfg = loadGatewayTestConfig();
  const agentIds = ["a", "b", "main"];
  const paths = agentIds.map((agentId) => openOpenClawAgentDatabase({ agentId, env }).path);
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const pathname of paths) {
    clearOpenClawAgentIntegrityVerification(pathname, env);
    const database = new DatabaseSync(pathname);
    try {
      database.exec("PRAGMA journal_mode=DELETE");
    } finally {
      database.close();
    }
  }
  const pause = pauseIntegrityInspections({
    root: resolveStateDir(env),
    paths,
    pausePaths: paths.slice(0, 2),
  });
  Object.assign(env, pause.env);
  let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
  try {
    const started = await withAgentDatabaseStartupAdmission(async () => {
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
    expect((await fetch(`http://127.0.0.1:${started.port}/healthz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${started.port}/readyz`)).status).toBe(503);
    await vi.waitFor(() => {
      for (const marker of pause.enteredPaths.slice(0, 2)) {
        expect(fs.existsSync(marker)).toBe(true);
      }
    });
    expect(fs.existsSync(pause.enteredPaths[2]!)).toBe(false);
    for (const agentId of agentIds) {
      expect(readAgentDatabaseAdmissionRefusal(agentId, { env })).toMatchObject({
        code: "agent-database-inspection-pending",
      });
    }
    expect(readAgentDatabaseAdmissionRefusal("absent", { env })).toBeUndefined();
    const absentOptions = { agentId: "absent", env };
    expect(fs.existsSync(resolveOpenClawAgentSqlitePath(absentOptions))).toBe(false);
    expect(openOpenClawAgentDatabase(absentOptions).agentId).toBe("absent");
    fs.writeFileSync(pause.releasePaths[1]!, "resume b");
    await vi.waitFor(
      () => {
        expect(fs.existsSync(pause.enteredPaths[2]!)).toBe(true);
        for (const agentId of ["b", "main"]) {
          expect(readAgentDatabaseAdmissionRefusal(agentId, { env })).toBeUndefined();
        }
      },
      { timeout: 10000 },
    );
    expect(readAgentDatabaseAdmissionRefusal("a", { env })).toMatchObject({
      code: "agent-database-inspection-pending",
    });
    expect((await fetch(`http://127.0.0.1:${started.port}/readyz`)).status).toBe(200);
    fs.writeFileSync(pause.releasePaths[0]!, "resume a");
    await vi.waitFor(
      () => expect(readAgentDatabaseAdmissionRefusal("a", { env })).toBeUndefined(),
      { timeout: 10000 },
    );
  } finally {
    fs.writeFileSync(pause.releasePath, "resume");
    await server?.close();
  }
});
