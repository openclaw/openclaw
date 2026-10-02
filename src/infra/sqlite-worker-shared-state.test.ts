import { execFileSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { NativeHookRelayBridgeRecord } from "../agents/harness/native-hook-relay-bridge-record.js";
import { normalizeSubagentRunState } from "../agents/subagents/registry/subagent-delivery-state.js";
import { registerRequiredQueuedSubagent } from "../agents/subagents/registry/subagent-registry-queued-registration.js";
import { persistSubagentRunsToDiskAsyncOrThrow } from "../agents/subagents/registry/subagent-registry-state.js";
import { bindSubagentRunRecord } from "../agents/subagents/registry/subagent-registry.store.codec.js";
import { loadSubagentRegistryFromSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { saveSubagentRegistryToSqlite } from "../agents/subagents/registry/subagent-registry.store.test-support.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { claimOpenClawStateOwnership } from "../state/openclaw-state-ownership-operations.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  executeOpenClawStateWorker,
  inspectOpenClawStateDatabase,
  runOpenClawStateWorkerOperation,
} from "../state/openclaw-state-worker-store.js";
import { withEnvAsync } from "../test-utils/env.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { acquireGatewayStateOwner } from "./gateway-state-owner.js";
import * as nodeSqlite from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { OpenClawStateOwnershipError } from "./sqlite-lifecycle-errors.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "./sqlite-worker-contract.js";
import { registerSharedStateWorkerAdmissionTests } from "./sqlite-worker-shared-state-admission.test-support.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

function context() {
  return captureOpenClawStateWorkerContext({
    env: { OPENCLAW_STATE_DIR: dirs.make("openclaw-worker-cold-") },
  });
}

function databaseOptions(captured: ReturnType<typeof context>) {
  return { path: captured.admission.databasePath, env: captured.environment };
}

const readMetadata = {
  type: "plugins.metadata.read",
  input: { selector: "installed-index", artifactPreservingReadOnly: true },
} as const;

async function seedMetadata(captured: ReturnType<typeof context>, value = { plugins: [] }) {
  writeConfigMachineState("plugins.installedIndex", value, databaseOptions(captured));
  await closeOpenClawStateDatabaseAsync();
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
      const captured = captureOpenClawStateWorkerContext({
        env,
        ...(part === "agent-path" ? { initializationAgentPaths: [padding] } : {}),
      });
      await expect(
        executeOpenClawStateWorker(captured, {
          type: "plugins.conversationBindingApprovals.read",
          input: undefined,
        }),
      ).rejects.toMatchObject({ code: "overloaded" });
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
      const captured = captureOpenClawStateWorkerContext({
        env,
        ...(source === "paths" ? { initializationAgentPaths: knownPaths } : {}),
      });
      env.OPENCLAW_CONFIG_PATH = path.join(root, "later.json");
      env.STORE_ROOT = path.join(root, "later");
      knownPaths[0] = path.join(root, "later", "openclaw-agent.sqlite");

      await executeOpenClawStateWorker(captured, {
        type: "plugins.conversationBindingApprovals.read",
        input: undefined,
      });
      expect(existsSync(captured.admission.databasePath)).toBe(true);
      const database = openOpenClawStateDatabase(databaseOptions(captured));
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
    "keeps typed %s errors for a reloaded caller of the existing shared worker",
    async (phase) => {
      const captured = context();
      await executeOpenClawStateWorker(captured, {
        type: "plugins.conversationBindingApprovals.read",
        input: undefined,
      });
      const database = openOpenClawStateDatabase(databaseOptions(captured));
      database.db.exec("PRAGMA user_version = 999999");
      if (phase === "open") {
        await closeOpenClawStateDatabaseAsync();
      }
      vi.resetModules();
      const [worker, contexts, errors] = await Promise.all([
        import("../state/openclaw-state-worker-store.js"),
        import("../state/openclaw-state-worker-context.js"),
        import("./sqlite-user-version.js"),
      ]);
      const current = contexts.captureOpenClawStateWorkerContext(databaseOptions(captured));
      const record: NativeHookRelayBridgeRecord = {
        relayId: "caller-errors",
        pid: 100,
        hostname: "127.0.0.1",
        port: 18789,
        token: "synthetic-caller-token",
        expiresAtMs: 20000,
      };
      let incoming: unknown;
      let failure: unknown;
      try {
        await worker.runOpenClawStateWorkerOperation(current, async (scope) => {
          try {
            return await scope.execute({
              type: "nativeHookRelay.write",
              input: { record, updatedAtMs: 1 },
            });
          } catch (error) {
            incoming = error;
            throw error;
          }
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(errors.SqliteSchemaVersionError);
      if (phase === "execute") {
        expect(incoming).toBe(failure);
      }
    },
  );

  it("hydrates concurrent lower-level open refusals in each caller's module graph", async () => {
    const captured = context();
    const database = openOpenClawStateDatabase(databaseOptions(captured));
    database.db.exec("PRAGMA user_version = 999999");
    await closeOpenClawStateDatabaseAsync();
    const first = await Promise.all([
      import("./sqlite-worker-store.js"),
      import("./sqlite-user-version.js"),
    ]);
    vi.resetModules();
    const second = await Promise.all([
      import("./sqlite-worker-store.js"),
      import("./sqlite-user-version.js"),
    ]);
    const options = {
      moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sharedStateStore),
      databasePath: captured.admission.databasePath,
    };
    const outcomes = await Promise.allSettled([
      first[0].openSharedStateSqliteWorkerStore(options, captured),
      second[0].openSharedStateSqliteWorkerStore(options, captured),
    ]);
    for (const result of outcomes) {
      if (result.status === "fulfilled") {
        await result.value?.close();
      }
    }
    const [left, right] = outcomes;
    if (left.status !== "rejected" || right.status !== "rejected") {
      throw new Error("Expected both callers to observe the schema refusal");
    }
    expect(left.reason).toBeInstanceOf(first[1].SqliteSchemaVersionError);
    expect(right.reason).toBeInstanceOf(second[1].SqliteSchemaVersionError);
    expect(left.reason).not.toBe(right.reason);
  });

  it.each(["create", "repair"] as const)(
    "performs cold %s under its Gateway owner without main-thread SQL",
    async (operation) => {
      const captured = context();
      const databasePath = captured.admission.databasePath;
      if (operation === "repair") {
        const database = openOpenClawStateDatabase({
          path: databasePath,
          env: captured.environment,
        });
        database.db.exec("DROP INDEX idx_subagent_runs_child_session_key");
        await closeOpenClawStateDatabaseAsync();
      }
      const admission = captureOpenClawStateWorkerContext({
        path: databasePath,
        env: captured.environment,
      });
      const gateway = acquireGatewayStateOwner({
        databasePath,
        payload: {
          pid: process.pid,
          createdAt: new Date().toISOString(),
          role: "gateway",
          stateDir: captured.environment.OPENCLAW_STATE_DIR,
          configPath: path.join(captured.environment.OPENCLAW_STATE_DIR, "openclaw.json"),
        },
      });
      const mainSql = observeMainThreadSql();
      try {
        expect(
          await executeOpenClawStateWorker(admission, {
            type: "plugins.conversationBindingApprovals.read",
            input: undefined,
          }),
        ).toEqual([]);
        mainSql.expectIdle();
        expect(admission.admission.identity.key).toMatch(/^file:/);
      } finally {
        mainSql.restore();
        await closeOpenClawStateDatabaseAsync();
        gateway.release();
      }
      const reopened = openOpenClawStateDatabase({ path: databasePath, env: captured.environment });
      expect(
        reopened.db
          .prepare("SELECT name FROM sqlite_schema WHERE name = ?")
          .get("idx_subagent_runs_child_session_key"),
      ).toEqual({ name: "idx_subagent_runs_child_session_key" });
    },
  );

  it.each(["Web Push", "GitHub publication"] as const)(
    "keeps metadata inspection and the first %s operation in the same actor",
    async (operation) => {
      const captured = context();
      const value = { generation: "prepared-metadata", plugins: [] };
      await seedMetadata(captured, value);
      const reopened = captureOpenClawStateWorkerContext(databaseOptions(captured));
      const messages = vi.spyOn(Worker.prototype, "postMessage");
      await runOpenClawStateWorkerOperation(
        reopened,
        async (scope) => {
          expect(await scope.execute(readMetadata)).toEqual({ value_json: JSON.stringify(value) });
          const metadataWorker = messages.mock.contexts[0];
          expect(metadataWorker).toBeInstanceOf(Worker);
          messages.mockClear();
          if (operation === "Web Push") {
            expect(
              await scope.execute({
                type: "webPush.listTerminalWebPushApprovalDeliveryIds",
                input: {},
              }),
            ).toEqual({ approvalIds: [], nextAfterApprovalId: null, throughApprovalId: null });
          } else {
            expect(
              await scope.execute({
                type: "githubRepository.personalPending",
                input: {
                  ownerProfileId: "profile-first-use",
                  sessionKey: "agent:main:github-first-use",
                  agentId: "main",
                },
              }),
            ).toBeUndefined();
          }
          expect(messages.mock.contexts.length).toBeGreaterThan(0);
          expect(messages.mock.contexts.every((worker) => worker === metadataWorker)).toBe(true);
          expect(await scope.execute(readMetadata)).toEqual({ value_json: JSON.stringify(value) });
        },
        { existingOnly: true },
      );
      await closeOpenClawStateDatabaseAsync();
      messages.mockRestore();
    },
  );

  it("leaves a missing database absent for existing-only inspection", async () => {
    const captured = context();
    const inspect = vi.fn(async () => "inspected");
    expect(
      await runOpenClawStateWorkerOperation(captured, inspect, { existingOnly: true }),
    ).toBeUndefined();
    expect(inspect).not.toHaveBeenCalled();
    expect(
      await inspectOpenClawStateDatabase(captured, {
        type: "database.generationMatches",
        input: {
          generation: {
            database: {
              birthtimeNs: 0n,
              ctimeNs: 0n,
              dev: 0n,
              ino: 0n,
              mtimeNs: 0n,
              size: 0n,
              sha256: "0".repeat(64),
            },
          },
        },
      }),
    ).toBeUndefined();
    expect(existsSync(captured.admission.databasePath)).toBe(false);
  });

  it.runIf(process.platform === "darwin" && existsSync("/usr/bin/SetFile"))(
    "permits a lazy write after same-inode birthtime metadata changes",
    async () => {
      const seeded = context();
      const databasePath = seeded.admission.databasePath;
      await seedMetadata(seeded);
      const captured = captureOpenClawStateWorkerContext(databaseOptions(seeded));
      await runOpenClawStateWorkerOperation(captured, (scope) => scope.execute(readMetadata), {
        existingOnly: true,
      });
      const before = statSync(databasePath, { bigint: true });
      // macOS can change birth time without reallocating the inode.
      execFileSync("/usr/bin/SetFile", ["-d", "01/02/2000 03:04:05", databasePath]);
      const after = statSync(databasePath, { bigint: true });
      expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
      expect(after.birthtimeNs).not.toBe(before.birthtimeNs);
      const input = {
        configPath: "/synthetic/changed-birthtime.json",
        patch: { last_observed_suspicious_signature: "metadata-change" },
        expected: null,
        updatedAtMs: 100,
      };
      await expect(
        executeOpenClawStateWorker(captured, { type: "config.health.patch", input }),
      ).resolves.toBe(true);
      await closeOpenClawStateDatabaseAsync();
      const database = openOpenClawStateDatabase({ path: databasePath, env: seeded.environment });
      const row = database.db
        .prepare(
          "SELECT last_observed_suspicious_signature FROM config_health_entries WHERE config_path = ?",
        )
        .get(input.configPath);
      expect(row).toEqual({ last_observed_suspicious_signature: "metadata-change" });
    },
  );

  it.each(["config health", "device identity", "audit"] as const)(
    "does not recreate a lazy actor's removed opening path through a warm hardlink (%s)",
    async (operation) => {
      const original = context();
      const originalPath = original.admission.databasePath;
      await seedMetadata(original);
      const aliasPath = path.join(dirs.make("openclaw-worker-warm-alias-"), "state.sqlite");
      linkSync(originalPath, aliasPath);
      const opening = captureOpenClawStateWorkerContext(databaseOptions(original));
      const alias = captureOpenClawStateWorkerContext({
        path: aliasPath,
        env: original.environment,
      });
      const inspect = (captured: typeof opening) =>
        runOpenClawStateWorkerOperation(captured, (scope) => scope.execute(readMetadata), {
          existingOnly: true,
        });
      await inspect(opening);
      await inspect(alias);
      renameSync(
        path.dirname(originalPath),
        path.join(dirs.make("openclaw-worker-moved-"), "state"),
      );
      const input = {
        configPath: "/synthetic/warm-alias.json",
        patch: { last_observed_suspicious_signature: "warm-alias" },
        expected: null,
        updatedAtMs: 100,
      };
      if (operation === "audit") {
        expect(
          await executeOpenClawStateWorker(alias, {
            type: "audit.writer.prune",
            input: "events",
          }),
        ).toMatchObject({ status: "settled", error: expect.any(String) });
      } else {
        await expect(
          executeOpenClawStateWorker(
            alias,
            operation === "config health"
              ? {
                  type: "config.health.patch",
                  input,
                }
              : {
                  type: "deviceIdentity.load",
                  input: { identityKey: "warm-alias-device" },
                },
          ),
        ).rejects.toThrow();
      }
      expect(existsSync(originalPath)).toBe(false);
      await closeOpenClawStateDatabaseAsync();
      const database = openOpenClawStateDatabase({ path: aliasPath, env: original.environment });
      expect(
        database.db
          .prepare("SELECT count(*) AS count FROM config_health_entries WHERE config_path = ?")
          .get(input.configPath),
      ).toEqual({
        count: 0,
      });
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
      const originalMaintenance = createOpenClawDatabaseMaintenanceScope();
      const relocatedMaintenance =
        ownership === "same scope" || ownership === "active secondary alias"
          ? originalMaintenance
          : createOpenClawDatabaseMaintenanceScope();
      const aliasMaintenance = healthyActor
        ? createOpenClawDatabaseMaintenanceScope()
        : relocatedMaintenance;
      try {
        const original = originalMaintenance.run(() =>
          captureOpenClawStateWorkerContext(databaseOptions(seeded)),
        );
        let survivingAlias: ReturnType<typeof captureOpenClawStateWorkerContext> | undefined;
        if (
          ownership === "surviving alias" ||
          ownership === "retired opening scope" ||
          ownership === "active retained alias" ||
          healthyActor
        ) {
          const aliasPath = path.join(dirs.make("openclaw-worker-live-alias-"), "state.sqlite");
          linkSync(originalPath, aliasPath);
          survivingAlias = aliasMaintenance.run(() =>
            captureOpenClawStateWorkerContext({ path: aliasPath, env: seeded.environment }),
          );
          if (healthyActor) {
            // C opens the actor before A receives its secondary client.
            expect(
              await runOpenClawStateWorkerOperation(
                survivingAlias,
                (scope) => scope.execute(readMetadata),
                { existingOnly: true },
              ),
            ).toEqual({ value_json: JSON.stringify(value) });
          }
        }
        const relocate = () => {
          const relocatedRoot = dirs.make("openclaw-worker-relocated-");
          // Relocation keeps the real inode while ending the old path's admission.
          renameSync(path.dirname(originalPath), path.join(relocatedRoot, "state"));
          const relocated = relocatedMaintenance.run(() =>
            captureOpenClawStateWorkerContext({
              env: { OPENCLAW_STATE_DIR: relocatedRoot },
            }),
          );
          expect(relocated.admission.identity.key).toBe(original.admission.identity.key);
          expect(existsSync(originalPath)).toBe(false);
          return relocated;
        };
        const input = {
          configPath: "/synthetic/relocated-state.json",
          patch: { last_observed_suspicious_signature: "current-database" },
          expected: null,
          updatedAtMs: 100,
        };
        const write = async (relocated: ReturnType<typeof captureOpenClawStateWorkerContext>) => {
          expect(
            await executeOpenClawStateWorker(relocated, {
              type: "config.health.patch",
              input,
            }),
          ).toBe(true);
        };
        const relocatedDuringCallback = await runOpenClawStateWorkerOperation(
          original,
          async (scope) => {
            expect(await scope.execute(readMetadata)).toEqual({
              value_json: JSON.stringify(value),
            });
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
        let relocatedDuringAliasCallback:
          | ReturnType<typeof captureOpenClawStateWorkerContext>
          | undefined;
        if (
          (ownership === "retired opening scope" || ownership === "active retained alias") &&
          survivingAlias
        ) {
          await runOpenClawStateWorkerOperation(
            survivingAlias,
            (scope) => scope.execute(readMetadata),
            { existingOnly: true },
          );
          await originalMaintenance.close();
          if (ownership === "active retained alias") {
            relocatedDuringAliasCallback = await runOpenClawStateWorkerOperation(
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
          relocatedDuringAliasCallback = await runOpenClawStateWorkerOperation(
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
        if (!healthyActor) {
          await write(relocated);
        }

        expect(existsSync(originalPath)).toBe(false);
        if (survivingAlias) {
          survivingAlias.admission.assertCurrent();
          expect(original.admission.assertCurrent).toThrow(/read admission changed/);
        }
        // Checkpoint the actor's opening path before inspecting its hardlink through B.
        await closeOpenClawStateDatabaseAsync();
        const database = openOpenClawStateDatabase(databaseOptions(relocated));
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
        await executeOpenClawStateWorker(captured, {
          type: "plugins.conversationBindingApprovals.read",
          input: undefined,
        });
      }
      claimOpenClawStateOwnership("synthetic-manager", {
        path: captured.admission.databasePath,
        env: { ...captured.environment, OPENCLAW_SUPERVISOR_MODE: "external" },
      });
      if (phase === "open") {
        await closeOpenClawStateDatabaseAsync();
      }
      const reopened = captureOpenClawStateWorkerContext(databaseOptions(captured));
      await expect(
        executeOpenClawStateWorker(reopened, {
          type: "plugins.conversationBindingApprovals.read",
          input: undefined,
        }),
      ).rejects.toBeInstanceOf(OpenClawStateOwnershipError);
    },
  );

  it("opens a fresh actor for the first new call after the previous worker exits", async () => {
    const captured = context();
    const messages = vi.spyOn(Worker.prototype, "postMessage");
    await executeOpenClawStateWorker(captured, {
      type: "plugins.conversationBindingApprovals.read",
      input: undefined,
    });
    const worker = messages.mock.contexts[0];
    messages.mockRestore();
    if (!(worker instanceof Worker)) {
      throw new Error("Expected the shared-state worker to receive its open request");
    }
    await worker.terminate();
    await expect(
      executeOpenClawStateWorker(captured, {
        type: "plugins.conversationBindingApprovals.read",
        input: undefined,
      }),
    ).resolves.toEqual([]);
    expect(
      await executeOpenClawStateWorker(captured, {
        type: "plugins.conversationBindingApprovals.read",
        input: undefined,
      }),
    ).toEqual([]);
  });
});

registerSharedStateWorkerAdmissionTests(context);

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
    const expected = [queued, terminal].map((entry) =>
      bindSubagentRunRecord(normalizeSubagentRunState(structuredClone(entry))),
    );
    const capturedContext = captureOpenClawStateWorkerContext();
    const sql = observeMainThreadSql();
    try {
      const write = persistSubagentRunsToDiskAsyncOrThrow(
        new Map([queued, terminal].map((entry) => [entry.runId, entry])),
        [queued.runId, terminal.runId, removed.runId],
        { context: capturedContext },
      );
      queued.task = "mutated after capture";
      queued.queuedLaunch.request.task = "mutated descriptor";
      terminal.completion.resultText = "mutated result";
      terminalReply.text = "mutated reply";
      await write;
      sql.expectIdle();
    } finally {
      sql.restore();
      await closeOpenClawStateDatabaseAsync();
    }
    const stored = loadSubagentRegistryFromSqlite();
    expect([...stored.keys()].toSorted()).toEqual(["private-terminal", "queued", "retained"]);
    expect(stored.get("queued")).toMatchObject({
      task: capturedTask,
      execution: { status: "queued" },
      completion: queued.completion,
      delivery: queued.delivery,
    });
    const database = openOpenClawStateDatabase(databaseOptions(capturedContext));
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
      await closeOpenClawStateDatabaseAsync();
    }
  });
});

it("awaits the queued registration caller's two writes without host SQL", async () => {
  await withEnvAsync({ OPENCLAW_STATE_DIR: dirs.make("openclaw-queued-caller-") }, async () => {
    const entry = createRun("queued-caller");
    entry.requesterStorePath = "synthetic-requester-store";
    entry.controllerStorePath = "synthetic-controller-store";
    entry.queuedLaunch = {
      request: { sessionKey: entry.childSessionKey },
      timeoutMs: 100,
      schedulerGroupKey: "synthetic-group",
      maxConcurrent: 1,
    };
    const descriptor = structuredClone(entry.queuedLaunch);
    const capturedContext = captureOpenClawStateWorkerContext();
    const runs = new Map([[entry.runId, entry]]);
    saveSubagentRegistryToSqlite(new Map());
    const activate = vi.fn();
    const sql = observeMainThreadSql();
    try {
      const registration = registerRequiredQueuedSubagent({
        context: capturedContext,
        entry,
        manager: {
          runs,
          getRunsForChildSession: () => runs.values(),
          getRuntimeConfig: () => ({}),
          persistAsyncOrThrow: (writeContext, publication, ...runIds) =>
            persistSubagentRunsToDiskAsyncOrThrow(runs, runIds, {
              context: writeContext,
              ...publication,
            }),
        },
        originals: new Map(),
        bindReservation: () => {},
        activate,
      });
      expect(entry.queuedLaunch).toBeUndefined();
      expect(activate).not.toHaveBeenCalled();
      await registration;
      sql.expectIdle();
      expect(activate).toHaveBeenCalledOnce();
      expect(entry.queuedLaunch).toEqual(descriptor);
    } finally {
      sql.restore();
      await closeOpenClawStateDatabaseAsync();
    }
    expect(loadSubagentRegistryFromSqlite().get(entry.runId)).toMatchObject({
      queuedLaunch: descriptor,
      requesterStorePath: entry.requesterStorePath,
      controllerStorePath: entry.controllerStorePath,
    });
    await closeOpenClawStateDatabaseAsync();
  });
});
