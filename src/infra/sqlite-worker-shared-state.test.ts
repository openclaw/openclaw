import { execFileSync } from "node:child_process";
import fs, {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { MessagePort, Worker } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { NativeHookRelayBridgeRecord } from "../agents/harness/native-hook-relay-bridge-record.js";
import {
  readNativeHookRelayBridgeRecord,
  renewOrRestoreNativeHookRelayBridgeRecord,
  writeNativeHookRelayBridgeRecord,
} from "../agents/harness/native-hook-relay-store.js";
import { mutateSubagentRuns } from "../agents/subagents/registry/subagent-registry-persistence.js";
import { registerRequiredQueuedSubagent } from "../agents/subagents/registry/subagent-registry-queued-registration.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { bindSubagentRunRecord } from "../agents/subagents/registry/subagent-registry.store.codec.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { readConfigMachineStateRowInDatabase } from "../state/config-machine-state-row.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { createOpenClawDatabaseMaintenanceScope as maintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseAsync as closeDatabase } from "../state/openclaw-state-db-cache.js";
import {
  openOpenClawStateDatabase as openDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { claimOpenClawStateOwnership } from "../state/openclaw-state-ownership-operations.js";
import { captureOpenClawStateWorkerContext as captureContext } from "../state/openclaw-state-worker-context.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import {
  executeOpenClawStateWorker as execute,
  runOpenClawStateWorkerOperation as runOperation,
} from "../state/openclaw-state-worker-store.js";
import { withEnvAsync } from "../test-utils/env.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { readGatewayLockProcessNamespace } from "./gateway-lock-payload.js";
import { acquireGatewayStateOwner } from "./gateway-state-owner.js";
import * as nodeSqlite from "./node-sqlite.js";
import { OpenClawStateOwnershipError } from "./sqlite-lifecycle-errors.js";
import { SqliteSchemaVersionError } from "./sqlite-user-version.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "./sqlite-worker-contract.js";
import { sqliteWorkerPreloadEnv } from "./sqlite-worker-preload.test-support.js";
import { registerSharedStateWorkerAdmissionTests } from "./sqlite-worker-shared-state-admission.test-support.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeDatabase();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

function context() {
  return captureContext({
    env: { OPENCLAW_STATE_DIR: dirs.make("openclaw-worker-cold-") },
  });
}

function databaseOptions(captured: ReturnType<typeof context>) {
  return { path: captured.admission.databasePath, env: captured.environment };
}

const readBindingApprovals = {
  type: "plugins.conversationBindingApprovals.read",
  input: undefined,
} as const;

const readProvenance = {
  type: "claws.install-schema-versions",
  input: { artifactPreservingReadOnly: true },
} as const;
const readApprovals = (captured: ReturnType<typeof context>) =>
  execute(captured, readBindingApprovals);
const inspectProvenance = (captured: ReturnType<typeof context>) =>
  runOperation(captured, (scope) => scope.execute(readProvenance), {
    existingOnly: true,
  });
const healthInput = (name: string, signature: string) => ({
  configPath: `/synthetic/${name}.json`,
  patch: { last_observed_suspicious_signature: signature },
  expected: null,
  updatedAtMs: 100,
});

async function seedMetadata(captured: ReturnType<typeof context>, value = { plugins: [] }) {
  writeConfigMachineState("plugins.installedIndex", value, databaseOptions(captured));
  await closeDatabase();
}

describe("canonical shared-state worker admission", () => {
  it.each(["key", "value", "agent-path"])(
    "bounds captured initialization %s bytes before opening",
    async (part) => {
      const padding = "x".repeat(SQLITE_WORKER_MAX_MESSAGE_BYTES);
      const env = {
        OPENCLAW_STATE_DIR: dirs.make("worker-environment-budget-"),
        [part === "key" ? padding : "PADDING"]: part === "value" ? padding : "x",
      };
      const captured = captureContext({
        env,
        ...(part === "agent-path" ? { initializationAgentPaths: [padding] } : {}),
      });
      await expect(readApprovals(captured)).rejects.toMatchObject({ code: "overloaded" });
      expect(existsSync(captured.admission.databasePath)).toBe(false);
    },
  );

  it.each(
    [false, true].flatMap((retained) =>
      (["config", "paths"] as const).map((source) => ({ retained, source })),
    ),
  )(
    "retains selected storage facts before worker initialization (retained: $retained, source: $source)",
    async ({ retained, source }) => {
      const root = dirs.make("worker-selected-storage-");
      const env = {
        HOME: path.join(root, "home"),
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_CONFIG_PATH: path.join(root, "selected.json"),
        STORE_ROOT: path.join(root, "retained"),
      };
      mkdirSync(env.HOME);
      mkdirSync(env.STORE_ROOT);
      const agentPath = path.join(env.STORE_ROOT, "openclaw-agent.sqlite");
      if (retained) {
        const database = nodeSqlite.openNodeSqliteDatabase(agentPath);
        database.exec(
          "CREATE TABLE retained_history (value TEXT); INSERT INTO retained_history VALUES ('kept')",
        );
        database.close();
      }
      const bytes = retained ? readFileSync(agentPath) : undefined;
      writeFileSync(
        env.OPENCLAW_CONFIG_PATH,
        source === "config"
          ? JSON.stringify({ agents: { entries: { main: { agentDir: "${STORE_ROOT}" } } } })
          : "{}",
      );
      const knownPaths = [agentPath];
      const captured = captureContext({
        env,
        ...(source === "paths" ? { initializationAgentPaths: knownPaths } : {}),
      });
      env.OPENCLAW_CONFIG_PATH = path.join(root, "later.json");
      env.STORE_ROOT = path.join(root, "later");
      knownPaths[0] = path.join(root, "later", "openclaw-agent.sqlite");

      await readApprovals(captured);
      expect(existsSync(captured.admission.databasePath)).toBe(true);
      const database = openDatabase(databaseOptions(captured));
      const journal = database.db
        .prepare("SELECT name FROM sqlite_schema WHERE name = 'agent_deletion_journal'")
        .get();
      if (retained) {
        expect(journal).toBeUndefined();
        expect(readFileSync(agentPath)).toEqual(bytes);
      } else {
        expect(journal).toEqual({ name: "agent_deletion_journal" });
      }
    },
  );

  it.each(["open", "execute"] as const)(
    "keeps typed %s errors from the existing shared worker",
    async (phase) => {
      const captured = context();
      mkdirSync(path.dirname(captured.admission.databasePath), { recursive: true });
      const database = nodeSqlite.openNodeSqliteDatabase(captured.admission.databasePath);
      try {
        database.exec("PRAGMA user_version = 999999");
      } finally {
        database.close();
      }
      const current = captureContext(databaseOptions(captured));
      if (phase === "execute") {
        await runOperation(current, async () => undefined, {
          existingOnly: true,
        });
      }
      const record: NativeHookRelayBridgeRecord = {
        relayId: "caller-errors",
        pid: 100,
        hostname: "127.0.0.1",
        port: 18789,
        token: "synthetic-caller-token",
        expiresAtMs: 20000,
      };
      let incoming: unknown;
      const failure = await runOperation(current, (scope) =>
        scope
          .execute({ type: "nativeHookRelay.write", input: { record, updatedAtMs: 1 } })
          .catch((error: unknown) => {
            incoming = error;
            throw error;
          }),
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SqliteSchemaVersionError);
      if (phase === "execute") {
        expect(incoming).toBe(failure);
      }
    },
  );

  it.each(["create", "repair"] as const)(
    "performs cold %s under its Gateway owner without main-thread SQL",
    async (operation) => {
      const captured = context();
      const databasePath = captured.admission.databasePath;
      if (operation === "repair") {
        const database = openDatabase(databaseOptions(captured));
        database.db.exec("DROP INDEX idx_subagent_runs_child_session_key");
        await closeDatabase();
      }
      const admission = captureContext(databaseOptions(captured));
      const gateway = acquireGatewayStateOwner({
        databasePath,
        payload: {
          pid: process.pid,
          processNamespace: readGatewayLockProcessNamespace(),
          createdAt: new Date().toISOString(),
          role: "gateway",
          stateDir: captured.environment.OPENCLAW_STATE_DIR,
          configPath: path.join(captured.environment.OPENCLAW_STATE_DIR, "openclaw.json"),
        },
      });
      const mainSql = observeMainThreadSql();
      try {
        expect(await readApprovals(admission)).toEqual([]);
        mainSql.expectIdle();
        expect(admission.admission.identity.key).toMatch(/^file:/);
      } finally {
        mainSql.restore();
        await closeDatabase();
        gateway.release();
      }
      const reopened = openDatabase(databaseOptions(captured));
      expect(
        reopened.db
          .prepare("SELECT name FROM sqlite_schema WHERE name = ?")
          .get("idx_subagent_runs_child_session_key"),
      ).toEqual({ name: "idx_subagent_runs_child_session_key" });
    },
  );

  it("keeps writer inspection and the first Web Push operation in the same actor", async () => {
    const captured = context();
    await seedMetadata(captured);
    const reopened = captureContext(databaseOptions(captured));
    const messages = vi.spyOn(Worker.prototype, "postMessage");
    await runOperation(
      reopened,
      async (scope) => {
        expect(await scope.execute(readBindingApprovals)).toEqual([]);
        const actorWorker = messages.mock.contexts[0];
        expect(actorWorker).toBeInstanceOf(Worker);
        messages.mockClear();
        expect(
          await scope.execute({
            type: "webPush.listTerminalWebPushApprovalDeliveryIds",
            input: {},
          }),
        ).toEqual({ approvalIds: [], nextAfterApprovalId: null, throughApprovalId: null });
        expect(messages.mock.contexts.length).toBeGreaterThan(0);
        expect(messages.mock.contexts.every((worker) => worker === actorWorker)).toBe(true);
        expect(await scope.execute(readBindingApprovals)).toEqual([]);
      },
      { existingOnly: true },
    );
    await closeDatabase();
    messages.mockRestore();
  });

  it("leaves a missing database absent for existing-only inspection", async () => {
    const captured = context();
    const inspect = vi.fn(async () => "inspected");
    expect(await runOperation(captured, inspect, { existingOnly: true })).toBeUndefined();
    expect(inspect).not.toHaveBeenCalled();
    expect(existsSync(captured.admission.databasePath)).toBe(false);
  });

  it.runIf(process.platform === "darwin" && existsSync("/usr/bin/SetFile"))(
    "permits a lazy write after same-inode birthtime metadata changes",
    async () => {
      const seeded = context();
      const databasePath = seeded.admission.databasePath;
      await seedMetadata(seeded);
      const captured = captureContext(databaseOptions(seeded));
      await inspectProvenance(captured);
      const before = statSync(databasePath, { bigint: true });
      // macOS can change birth time without reallocating the inode.
      execFileSync("/usr/bin/SetFile", ["-d", "01/02/2000 03:04:05", databasePath]);
      const after = statSync(databasePath, { bigint: true });
      expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
      expect(after.birthtimeNs).not.toBe(before.birthtimeNs);
      const input = healthInput("changed-birthtime", "metadata-change");
      await expect(execute(captured, { type: "config.health.patch", input })).resolves.toBe(true);
      await closeDatabase();
      const database = openDatabase(databaseOptions(seeded));
      const row = database.db
        .prepare(
          "SELECT last_observed_suspicious_signature FROM config_health_entries WHERE config_path = ?",
        )
        .get(input.configPath);
      expect(row).toEqual({ last_observed_suspicious_signature: "metadata-change" });
    },
  );

  it.each(["config health", "machine state", "audit"] as const)(
    "does not recreate a lazy actor's removed opening path through a warm hardlink (%s)",
    async (operation) => {
      const original = context();
      const originalPath = original.admission.databasePath;
      await seedMetadata(original);
      const aliasPath = path.join(dirs.make("openclaw-worker-warm-alias-"), "state.sqlite");
      linkSync(originalPath, aliasPath);
      const opening = captureContext(databaseOptions(original));
      const alias = captureContext({
        path: aliasPath,
        env: original.environment,
      });
      await inspectProvenance(opening);
      await inspectProvenance(alias);
      renameSync(
        path.dirname(originalPath),
        path.join(dirs.make("openclaw-worker-moved-"), "state"),
      );
      const input = healthInput("warm-alias", "warm-alias");
      if (operation === "audit") {
        expect(
          await execute(alias, {
            type: "audit.writer.prune",
            input: undefined,
          }),
        ).toEqual(
          Array.from({ length: 4 }, () => ({ status: "settled", error: expect.any(String) })),
        );
      } else {
        await expect(
          execute(
            alias,
            operation === "config health"
              ? { type: "config.health.patch", input }
              : {
                  type: "machineState.write",
                  input: { key: "warm-alias-state", value: "must-not-commit" },
                },
          ),
        ).rejects.toThrow();
      }
      expect(existsSync(originalPath)).toBe(false);
      await closeDatabase();
      const database = openDatabase({ path: aliasPath, env: original.environment });
      expect(
        database.db
          .prepare("SELECT count(*) AS count FROM config_health_entries WHERE config_path = ?")
          .get(input.configPath),
      ).toEqual({ count: 0 });
      expect(readConfigMachineStateRowInDatabase(database.db, "warm-alias-state")).toBeUndefined();
    },
  );

  it.each([
    "same scope",
    "different scope",
    "active callback",
    "surviving alias",
    "retired opening scope",
    "active retained alias",
    "active opening alias",
    "active secondary alias",
  ] as const)(
    "writes to the relocated database without recreating a retired inspection path (%s)",
    async (ownership) => {
      const seeded = context();
      const originalPath = seeded.admission.databasePath;
      const value = { generation: "retained-before-relocation", plugins: [] };
      await seedMetadata(seeded, value);
      const healthyActor =
        ownership === "active opening alias" || ownership === "active secondary alias";
      const originalMaintenance = maintenanceScope();
      const relocatedMaintenance =
        ownership === "same scope" || ownership === "active secondary alias"
          ? originalMaintenance
          : maintenanceScope();
      const aliasMaintenance = healthyActor ? maintenanceScope() : relocatedMaintenance;
      try {
        const original = originalMaintenance.run(() => captureContext(databaseOptions(seeded)));
        let survivingAlias: ReturnType<typeof captureContext> | undefined;
        if (
          ownership === "surviving alias" ||
          ownership === "retired opening scope" ||
          ownership === "active retained alias" ||
          healthyActor
        ) {
          const aliasPath = path.join(dirs.make("openclaw-worker-live-alias-"), "state.sqlite");
          linkSync(originalPath, aliasPath);
          survivingAlias = aliasMaintenance.run(() =>
            captureContext({ path: aliasPath, env: seeded.environment }),
          );
          if (healthyActor) {
            // C opens the actor before A receives its secondary client.
            expect(await inspectProvenance(survivingAlias)).toEqual([]);
          }
        }
        const relocate = () => {
          const relocatedRoot = dirs.make("openclaw-worker-relocated-");
          // Relocation keeps the real inode while ending the old path's admission.
          renameSync(path.dirname(originalPath), path.join(relocatedRoot, "state"));
          const relocated = relocatedMaintenance.run(() =>
            captureContext({
              env: { OPENCLAW_STATE_DIR: relocatedRoot },
            }),
          );
          expect(relocated.admission.identity.key).toBe(original.admission.identity.key);
          expect(existsSync(originalPath)).toBe(false);
          return relocated;
        };
        const input = healthInput("relocated-state", "current-database");
        const write = async (relocated: ReturnType<typeof captureContext>) => {
          expect(await execute(relocated, { type: "config.health.patch", input })).toBe(true);
        };
        const relocatedDuringCallback = await runOperation(
          original,
          async (scope) => {
            expect(await scope.execute(readProvenance)).toEqual([]);
            if (ownership === "active callback") {
              const relocated = relocate();
              // The old callback cannot await its own retirement through a new caller.
              await expect(write(relocated)).rejects.toMatchObject({
                code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
              });
              expect(existsSync(originalPath)).toBe(false);
              return relocated;
            }
            if (ownership === "active secondary alias") {
              const relocated = relocate();
              // B shares A's scope but must not wait for this callback to close its stale client.
              await write(relocated);
              return relocated;
            }
            return undefined;
          },
          { existingOnly: true },
        );
        let relocatedDuringAliasCallback: ReturnType<typeof captureContext> | undefined;
        if (
          (ownership === "retired opening scope" || ownership === "active retained alias") &&
          survivingAlias
        ) {
          await inspectProvenance(survivingAlias);
          await originalMaintenance.close();
          if (ownership === "active retained alias") {
            relocatedDuringAliasCallback = await runOperation(
              survivingAlias,
              async (scope) => {
                const relocated = relocate();
                await expect(
                  scope.execute({ type: "config.health.patch", input }),
                ).rejects.toMatchObject({ code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED" });
                expect(existsSync(originalPath)).toBe(false);
                return relocated;
              },
              { existingOnly: true },
            );
          }
        }
        if (ownership === "active opening alias" && survivingAlias) {
          relocatedDuringAliasCallback = await runOperation(
            survivingAlias,
            async () => {
              const relocated = relocate();
              await write(relocated);
              return relocated;
            },
            { existingOnly: true },
          );
        }
        const relocated = relocatedDuringCallback ?? relocatedDuringAliasCallback ?? relocate();
        expect(existsSync(originalPath)).toBe(false);
        if (survivingAlias) {
          survivingAlias.admission.assertCurrent();
          expect(original.admission.assertCurrent).toThrow(/read admission changed/);
        }
        if (!healthyActor) {
          // Relocation ends the old actor; reopen explicitly after its callbacks settle.
          await closeDatabase();
          const current = relocatedMaintenance.run(() =>
            captureContext(databaseOptions(relocated)),
          );
          await write(current);
        }
        // Checkpoint the actor's opening path before inspecting its hardlink through B.
        await closeDatabase();
        const database = openDatabase(databaseOptions(relocated));
        expect(
          database.db
            .prepare(
              "SELECT last_observed_suspicious_signature, updated_at_ms FROM config_health_entries WHERE config_path = ?",
            )
            .get(input.configPath),
        ).toEqual({ last_observed_suspicious_signature: "current-database", updated_at_ms: 100 });
        expect(
          database.db
            .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
            .get("plugins.installedIndex"),
        ).toEqual({ value_json: JSON.stringify(value) });
      } finally {
        await originalMaintenance.close();
        if (relocatedMaintenance !== originalMaintenance) {
          await relocatedMaintenance.close();
        }
        if (aliasMaintenance !== relocatedMaintenance) {
          await aliasMaintenance.close();
        }
      }
    },
  );

  it.each(["open", "execute"] as const)(
    "preserves external ownership rejection from worker %s",
    async (phase) => {
      const captured = context();
      if (phase === "execute") {
        await readApprovals(captured);
      }
      claimOpenClawStateOwnership("synthetic-manager", {
        path: captured.admission.databasePath,
        env: { ...captured.environment, OPENCLAW_SUPERVISOR_MODE: "external" },
      });
      if (phase === "open") {
        await closeDatabase();
      }
      const reopened = captureContext(databaseOptions(captured));
      await expect(readApprovals(reopened)).rejects.toBeInstanceOf(OpenClawStateOwnershipError);
    },
  );

  it("opens a fresh actor for the first new call after the previous worker exits", async () => {
    const captured = context();
    const messages = vi.spyOn(Worker.prototype, "postMessage");
    await readApprovals(captured);
    const worker = messages.mock.contexts[0];
    messages.mockRestore();
    if (!(worker instanceof Worker)) {
      throw new Error("Expected the shared-state worker to receive its open request");
    }
    await worker.terminate();
    await expect(readApprovals(captured)).resolves.toEqual([]);
    expect(await readApprovals(captured)).toEqual([]);
  });
});

registerSharedStateWorkerAdmissionTests(context);

it.each([true, false])(
  "services a worker grant through a directory alias behind a synchronous shared-state writer (owner current: %s)",
  async (ownerCurrent) => {
    const root = dirs.make("openclaw-state-admission-");
    const actual = path.join(root, "actual");
    const alias = path.join(root, "alias");
    fs.mkdirSync(actual);
    fs.symlinkSync(actual, alias, "junction");
    vi.stubEnv("OPENCLAW_STATE_DIR", alias);
    const marker = path.join(root, "transaction-held");
    const preload = path.join(root, "observe-admission.cjs");
    fs.writeFileSync(
      preload,
      `const { MessagePort, isMainThread } = require("node:worker_threads");
const fs = require("node:fs");
if (!isMainThread) {
  const post = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function(message, ...rest) {
    if (message?.stage === "transaction" && message.decision instanceof SharedArrayBuffer) {
      fs.writeFileSync(${JSON.stringify(marker)}, "transaction-held");
    }
    return Reflect.apply(post, this, [message, ...rest]);
  };
}
`,
    );
    for (const [key, value] of Object.entries(sqliteWorkerPreloadEnv(preload))) {
      vi.stubEnv(key, value);
    }
    const stateDbPath = path.join(alias, "state", "openclaw.sqlite");
    const record: NativeHookRelayBridgeRecord = {
      relayId: "relay-concurrent-writer",
      pid: process.pid,
      hostname: "127.0.0.1",
      port: 12345,
      token: "synthetic-relay-token",
      expiresAtMs: Date.now() + 60_000,
    };
    const posts = vi.spyOn(Worker.prototype, "postMessage");
    await writeNativeHookRelayBridgeRecord({ record, stateDbPath });
    const worker = posts.mock.contexts[0];
    posts.mockRestore();
    if (!(worker instanceof Worker)) {
      throw new Error("Expected the shared-state worker");
    }
    openDatabase({ path: stateDbPath });
    fs.rmSync(marker);
    let current = true;
    const mutation = vi.fn(() => "committed");
    const nativePost = worker.postMessage.bind(worker);
    const dispatch = vi.spyOn(worker, "postMessage").mockImplementation((message, transferList) => {
      const result = nativePost(message, transferList);
      const request = asOptionalRecord(message);
      if (request?.type !== "execute" || !(request.operationAdmission instanceof MessagePort)) {
        return result;
      }
      dispatch.mockRestore();
      // Keep the host listener queued until the worker owns its transaction,
      // then enter the competing synchronous write on the same event-loop turn.
      const deadline = Date.now() + 5_000;
      const pause = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(marker)) {
        if (Date.now() >= deadline) {
          throw new Error("Worker did not reach its transaction admission");
        }
        Atomics.wait(pause, 0, 0, 1);
      }
      current = ownerCurrent;
      runOpenClawStateWriteTransaction(mutation, { path: stateDbPath });
      return result;
    });
    const expiresAtMs = record.expiresAtMs + 1;
    const renewal = renewOrRestoreNativeHookRelayBridgeRecord({
      record: { ...record, expiresAtMs },
      stateDbPath,
      assertCurrent: () => {
        if (!current) {
          throw new Error("Native hook relay authority revoked");
        }
      },
    });
    if (ownerCurrent) {
      await expect(renewal).resolves.toBe(true);
    } else {
      await expect(renewal).rejects.toThrow("Native hook relay authority revoked");
    }
    expect(mutation).toHaveBeenCalledOnce();
    expect(await readNativeHookRelayBridgeRecord({ relayId: record.relayId, stateDbPath })).toEqual(
      { ...record, expiresAtMs: ownerCurrent ? expiresAtMs : record.expiresAtMs },
    );
  },
);

function createRun(runId: string): SubagentRunRecord {
  return {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "captured task",
    cleanup: "keep",
    createdAt: 100,
    execution: { status: "queued" },
    completion: { required: false },
    delivery: { status: "not_required" },
  };
}

it("commits captured registry rows without host SQL", async () => {
  await withEnvAsync({ OPENCLAW_STATE_DIR: dirs.make("openclaw-registry-worker-") }, async () => {
    const retained = createRun("retained");
    const removed = createRun("removed");
    saveSubagentRegistryToSqlite(
      new Map([
        [retained.runId, retained],
        [removed.runId, removed],
      ]),
    );
    const queued = createRun("queued");
    const capturedTask = 'captured task with "quotes", \\slashes, and 🦞\n'.repeat(256);
    queued.task = capturedTask;
    queued.queuedLaunch = {
      request: { sessionKey: queued.childSessionKey, task: queued.task },
      timeoutMs: 100,
      schedulerGroupKey: "synthetic-group",
      maxConcurrent: 1,
    };
    const terminal = createRun("private-terminal");
    terminal.completionTarget = "parent";
    terminal.execution = { status: "terminal", endedAt: 200 };
    const terminalReply = {
      disposition: "visible" as const,
      text: "[Mon 2026-09-21 12:00 UTC] [Mon 2026-09-21 12:00 UTC] captured reply",
    };
    terminal.completion = {
      required: false,
      resultText: "captured result 🦞\n".repeat(256),
      terminalReply,
    };
    const expected = [queued, terminal].map(bindSubagentRunRecord);
    const capturedContext = captureContext();
    const runs = new Map([[removed.runId, removed]]);
    const captured = createDeferredCore();
    const release = createDeferredCore();
    const runWorker = stateWorker.runOpenClawStateWorkerOperation;
    const transport = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((writeContext, operation, options) =>
        runWorker(
          writeContext,
          (scope) =>
            operation({
              ...scope,
              execute: async (command) => {
                if (command.type === "subagents.persistChanges") {
                  captured.resolve();
                  await release.promise;
                }
                return scope.execute(command);
              },
            }),
          options,
        ),
      );
    const sql = observeMainThreadSql();
    const write = mutateSubagentRuns(
      [queued.runId, terminal.runId, removed.runId],
      () => ({
        value: undefined,
        postimages: new Map<string, SubagentRunRecord | null>([
          [queued.runId, queued],
          [terminal.runId, terminal],
          [removed.runId, null],
        ]),
      }),
      { runs, context: capturedContext },
    );
    void write.catch(() => {});
    try {
      expect(
        await Promise.race([captured.promise.then(() => "captured"), write.then(() => "settled")]),
      ).toBe("captured");
      queued.task = "mutated after capture";
      queued.queuedLaunch.request.task = "mutated descriptor";
      terminal.completion.resultText = "mutated result";
      terminalReply.text = "mutated reply";
      expect(runs.has(queued.runId)).toBe(false);
      expect(runs.has(removed.runId)).toBe(true);
      release.resolve();
      await write;
      sql.expectIdle();
      expect(runs.get(queued.runId)?.task).toBe(capturedTask);
      expect(runs.has(removed.runId)).toBe(false);
    } finally {
      release.resolve();
      await write.catch(() => {});
      sql.restore();
      transport.mockRestore();
      await closeDatabase();
    }
    const stored = loadSubagentRegistryFromSqlite();
    expect([...stored.keys()].toSorted()).toEqual(["private-terminal", "queued", "retained"]);
    expect(stored.get("queued")).toMatchObject({
      task: capturedTask,
      execution: { status: "queued" },
      completion: queued.completion,
      delivery: queued.delivery,
    });
    const database = openDatabase(databaseOptions(capturedContext));
    for (const row of expected) {
      expect(
        database.db.prepare("SELECT * FROM subagent_runs WHERE run_id = ?").get(row.run_id),
      ).toMatchObject(row);
    }
    expect(expected[1]?.payload_json).toContain('"parentCompletion":');
    const calibration = observeMainThreadSql();
    try {
      database.db.exec("BEGIN EXCLUSIVE;");
      database.db.exec("ROLLBACK");
      expect(() => calibration.expectIdle()).toThrow();
    } finally {
      calibration.restore();
      await closeDatabase();
    }
  });
});

it("awaits the queued registration caller's two writes without host SQL", async () => {
  await withEnvAsync({ OPENCLAW_STATE_DIR: dirs.make("openclaw-queued-caller-") }, async () => {
    const entry = createRun("queued-caller");
    entry.requesterStorePath = "synthetic-requester-store";
    entry.controllerStorePath = "synthetic-controller-store";
    const descriptor = {
      request: { sessionKey: entry.childSessionKey },
      timeoutMs: 100,
      schedulerGroupKey: "synthetic-group",
      maxConcurrent: 1,
    };
    const capturedContext = captureContext();
    const runs = new Map<string, SubagentRunRecord>();
    saveSubagentRegistryToSqlite(new Map());
    const activate = vi.fn();
    const sql = observeMainThreadSql();
    try {
      await mutateSubagentRuns(
        [entry.runId],
        () => ({
          value: undefined,
          postimages: new Map([[entry.runId, entry]]),
        }),
        { runs, context: capturedContext },
      );
      const registration = registerRequiredQueuedSubagent({
        context: capturedContext,
        entry,
        manager: {
          runs,
          getRunsForChildSession: () => runs.values(),
          getRuntimeConfig: () => ({}),
        },
        queuedLaunch: descriptor,
        activate,
      });
      expect(runs.get(entry.runId)?.queuedLaunch).toBeUndefined();
      expect(activate).not.toHaveBeenCalled();
      await registration;
      sql.expectIdle();
      expect(activate).toHaveBeenCalledOnce();
      expect(runs.get(entry.runId)?.queuedLaunch).toEqual(descriptor);
    } finally {
      sql.restore();
      await closeDatabase();
    }
    expect(loadSubagentRegistryFromSqlite().get(entry.runId)).toMatchObject({
      queuedLaunch: descriptor,
      requesterStorePath: entry.requesterStorePath,
      controllerStorePath: entry.controllerStorePath,
    });
    await closeDatabase();
  });
});
