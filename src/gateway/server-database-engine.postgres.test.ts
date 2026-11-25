import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { getEnvironmentData } from "node:worker_threads";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
  readRequestText,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { resolvePendingFinalDeliveryCompletion } from "../auto-reply/reply/pending-final-delivery.js";
import { cliRecoveryEntrypoints } from "../cli/cli-entrypoint.test-support.js";
import { runCliProcessChild } from "../cli/cli-process-child.test-helpers.js";
import { runStartupConfigPreflight } from "../commands/startup-config-preflight.js";
import { resetConfigRuntimeState } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import { computeBackoffMs } from "../infra/delivery-recovery.shared.js";
import { migrateLegacyDesktopStreamOptOuts } from "../infra/device-pairing-node-desktop-migration.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { markFinal } from "../infra/outbound/delivery-completion.shard-test-support.js";
import {
  enqueueDeliveryOnce,
  markDeliveryPlatformOutcomeUnknown,
} from "../infra/outbound/delivery-queue-storage.js";
import type { QueuedDelivery } from "../infra/outbound/delivery-queue-types.js";
import { dropPostgresTestSchemas } from "../infra/postgres-sync/schema-cleanup.test-support.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { resetLogger } from "../logging/logger.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { withSecureTestNodeCommand } from "../secrets/test-node-command.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../state/openclaw-state-worker-store.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { writeSinkPlugin } from "./gateway.sessions-send-provenance.transport.test-support.js";
import {
  createDeliveryCrashPreload,
  createDeliveryCrashReader,
  recoverNoticeCommitCrash,
  readPostgresAnchor,
} from "./server-database-engine-delivery-crash.test-support.js";
import { installGatewayDatabaseEngine } from "./server-database-engine.js";
import { prepareGatewayServerBootstrap } from "./server-startup-bootstrap.js";
import { loadGatewayWorkerEnvironmentStartupState } from "./server-worker-environment-startup.js";
import { createWorkerStartupRuntime } from "./server-worker-environment-startup.runtime.test-support.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const DSN_ENV = "OPENCLAW_PGPREP_BOOTSTRAP_DSN";
const PREFIX = `pgprep_boot_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const PREFS_PATH = "/synthetic/postgres-bootstrap";

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function bootstrap() {
  const preflight = await runStartupConfigPreflight({ gateway: true, observe: false });
  expect(preflight.snapshot.valid).toBe(true);
  await using caches = new AsyncDisposableStack();
  caches.use(preflight.pluginCache);
  const log = createSubsystemLogger("gateway/postgres-bootstrap-test");
  const prepared = await prepareGatewayServerBootstrap({
    port: 18789,
    opts: {
      startupConfigSnapshotRead: preflight,
      bind: "loopback",
      controlUiEnabled: false,
      sidecarStartup: "defer",
    },
    log,
    logSecrets: log,
    loadWorkerEnvironmentStartupModule: () => import("./server-worker-environment-startup.js"),
    formatRuntimeGatewayAuthTokenWarning: () => "unused",
  });
  prepared.startupTrace.close();
  return prepared.configSnapshot;
}

describe.skipIf(!connection)("Gateway PostgreSQL shared-state bootstrap", () => {
  const client = new pg.Client({ connectionString: connection });
  let state: OpenClawTestState | undefined;

  beforeAll(() => client.connect());
  afterAll(() => client.end());

  async function queryRows<T extends pg.QueryResultRow>(sql: string, values: unknown[]) {
    return (await client.query<T>(sql, values)).rows;
  }
  async function bootstrapped(execCommand?: string) {
    const current = await fixture(connection, execCommand);
    const snapshot = await bootstrap();
    await closeStateDatabaseForTest();
    const anchor = await readPostgresAnchor(current);
    if (!anchor) {
      throw new Error("Gateway bootstrap did not open shared state");
    }
    return { current, snapshot, anchor };
  }
  afterEach(async () => {
    clearSecretsRuntimeSnapshot();
    resetConfigRuntimeState();
    await closeStateDatabaseForTest();
    try {
      // Real agent turns also create agent namespaces; drain owners before removing either family.
      await state?.restoreEnv();
      await dropPostgresTestSchemas(client, PREFIX);
    } finally {
      await state?.cleanup();
      state = undefined;
      resetLogger();
      resetDatabaseEngineSelectionForTest();
    }
  });

  async function fixture(dsn = connection ?? "", execCommand?: string): Promise<OpenClawTestState> {
    state = await createOpenClawTestState({
      label: "gateway-postgres-bootstrap",
      env: {
        [DSN_ENV]: dsn,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_GATEWAY_RESTART_TRACE: "0",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    await state.writeConfig({
      database: {
        engine: "postgres",
        postgres: {
          connection: execCommand
            ? { source: "exec", provider: "database", id: "connection" }
            : { source: "env", provider: "default", id: DSN_ENV },
          schemaPrefix: PREFIX,
        },
      },
      ...(execCommand
        ? {
            secrets: {
              providers: {
                database: {
                  source: "exec",
                  command: execCommand,
                  args: [
                    "-e",
                    "process.stdin.resume(); require('node:fs').appendFileSync(process.env.OPENCLAW_PGPREP_EXEC_CALLS, 'resolved\\n'); process.stdout.write(process.env.OPENCLAW_PGPREP_BOOTSTRAP_DSN)",
                  ],
                  passEnv: [DSN_ENV],
                  env: { OPENCLAW_PGPREP_EXEC_CALLS: state.path("exec-calls.log") },
                  jsonOnly: false,
                },
              },
            },
          }
        : {}),
      gateway: {
        mode: "local",
        auth: { mode: "token", token: "postgres-bootstrap-synthetic-token" },
        controlUi: { enabled: false },
      },
      plugins: { enabled: false },
      skills: { load: { watch: false } },
    });
    return state;
  }

  it("reports invalid config with exit 78 through gateway run on PostgreSQL and SQLite", async () => {
    const { current, snapshot } = await bootstrapped();
    const agents = { entries: { main: {}, helper: {} } };
    await current.writeConfig({ ...snapshot.sourceConfig, agents });
    const sqliteConfigPath = current.path("sqlite-invalid.json");
    await fs.writeFile(sqliteConfigPath, JSON.stringify({ gateway: { mode: "local" }, agents }));
    const diagnostic =
      'agents.ownership: multi-agent rosters require agents.ownership="explicit" or one legacy default=true marker; add agents.ownership="explicit" or run openclaw doctor';
    const nodeExecutable = resolveTestNodeExecPath();
    for (const engine of ["sqlite", "postgres"]) {
      const result = await runCliProcessChild({
        nodeExecutable,
        timeoutMs: 30_000,
        nodeArgs: [
          ...resolveRuntimeWorkerArgv(
            resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli),
            nodeExecutable,
          ),
          "gateway",
          "run",
        ],
        env: {
          ...process.env,
          ...current.env,
          ...(engine === "sqlite"
            ? { OPENCLAW_CONFIG_PATH: sqliteConfigPath, OPENCLAW_STATE_DIR: current.path("sqlite") }
            : {}),
          NODE_ENV: undefined,
          NODE_OPTIONS: undefined,
          VITEST: undefined,
          VITEST_POOL_ID: undefined,
          VITEST_WORKER_ID: undefined,
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_HIDE_BANNER: "1",
        },
      });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result, `${engine}: ${output}`).toMatchObject({ code: 78, signal: null });
      expect(output).toContain(diagnostic);
      expect(output).not.toContain("Cannot open PostgreSQL connection");
    }
  });

  it("resolves an exec DSN during bootstrap, captures workers' input, and reuses the anchor on restart", () =>
    withSecureTestNodeCommand(async (command) => {
      const { current, snapshot, anchor } = await bootstrapped(command);
      const callsPath = current.path("exec-calls.log");
      const initialResolutions = await fs.readFile(callsPath, "utf8");
      expect(initialResolutions).toContain("resolved\n");
      expect(await fs.readFile(current.configPath, "utf8")).not.toContain(connection);
      expect(anchor.namespace).toMatch(new RegExp(`^${PREFIX}_state_[a-f0-9]{16}$`, "u"));
      const metadata = await queryRows(
        `SELECT store_id FROM ${quoteIdentifier(anchor.namespace)}.openclaw_schema_meta WHERE store = $1`,
        ["state"],
      );
      expect(metadata).toEqual([{ store_id: anchor.storeId }]);
      const completion = await queryRows(
        `SELECT value_json FROM ${quoteIdentifier(anchor.namespace)}.config_machine_state WHERE state_key = $1`,
        [`webhookListeners:${current.configPath}`],
      );
      expect(completion).toEqual([{ value_json: "true" }]);

      await installGatewayDatabaseEngine(snapshot);
      expect(await migrateLegacyDesktopStreamOptOuts({}, current.stateDir)).toBe(0);
      expect(
        await queryRows(
          `SELECT status, report_json FROM ${quoteIdentifier(anchor.namespace)}.migration_runs WHERE id = $1`,
          ["node-desktop-stream-pairing-defaults-v1"],
        ),
      ).toEqual([
        { status: "completed", report_json: JSON.stringify({ retiredDesktopApprovals: 0 }) },
      ]);
      expect(await migrateLegacyDesktopStreamOptOuts({}, current.stateDir)).toBe(0);
      const workers = await loadGatewayWorkerEnvironmentStartupState();
      try {
        expect(workers.store.list()).toEqual([]);
        expect(await workers.placementStore.listAsync()).toEqual([]);
        const registry = createEmptyPluginRegistry();
        const runtime = await createWorkerStartupRuntime(workers, () => registry);
        try {
          expect(runtime.workerEnvironmentService).toBeDefined();
        } finally {
          await runtime.workerEnvironmentService?.stop();
        }
      } finally {
        await workers.store.close();
      }
      const context = captureOpenClawStateWorkerContext({ env: current.env });
      // A captured lifetime must not re-resolve its SecretRef when a worker opens later.
      await withEnvAsync({ [DSN_ENV]: "postgresql://127.0.0.1:1/unreachable" }, async () => {
        await executeOpenClawStateWorker(context, {
          type: "machineState.write",
          input: { key: "tts.prefsPath", value: PREFS_PATH },
        });
        const read = await executeExistingOpenClawStateRead(
          { env: current.env },
          { type: "tts.prefsPath" },
          { context },
        );
        expect(read?.row?.value_json).toBe(JSON.stringify(PREFS_PATH));
        expect(await fs.readFile(callsPath, "utf8")).toBe(initialResolutions);
      });
      await closeStateDatabaseForTest();
      clearSecretsRuntimeSnapshot();
      resetConfigRuntimeState();
      resetDatabaseEngineSelectionForTest();

      await bootstrap();
      await closeStateDatabaseForTest();
      expect((await fs.readFile(callsPath, "utf8")).length).toBeGreaterThan(
        initialResolutions.length,
      );
      expect(await readPostgresAnchor(current)).toEqual(anchor);
      const persisted = await queryRows(
        `SELECT value_json FROM ${quoteIdentifier(anchor.namespace)}.config_machine_state WHERE state_key = $1`,
        ["tts.prefsPath"],
      );
      expect(persisted).toEqual([{ value_json: JSON.stringify(PREFS_PATH) }]);
    }));

  it.for([
    "receipt-before-ack",
    "acceptance-before-receipt",
    "response-lost",
    "notice-ack-reply-lost",
    "notice-transcript-reply-lost",
  ] as const)(
    "recovers a queued final after its Gateway dies at %s",
    { timeout: 90_000 },
    async (window, { signal }) => {
      const receiptCommitted = window === "receipt-before-ack";
      const noticeCrash = window.startsWith("notice-");
      await using resources = new AsyncDisposableStack();
      type Boundary = { id: string; pid: number };
      const held = createDeferred<Boundary>();
      const recovered = createDeferred<Boundary>();
      const deliveries: Array<{ to: string; text: string }> = [];
      const summary = "Committed final result.";
      const server = createServer((request, response) => {
        void (async () => {
          const body = await readRequestText(request);
          if (request.method === "POST" && request.url === "/sink") {
            deliveries.push(JSON.parse(body));
            if (window === "response-lost") {
              // The sink accepted the request; the caller receives no response or identity.
              response.destroy();
              return;
            }
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ channel: "telegram", messageId: "accepted-final" }));
          } else if (request.method === "POST" && request.url === "/held") {
            held.resolve(JSON.parse(body));
            response.writeHead(204).end();
          } else if (request.method === "POST" && request.url === "/recovered") {
            recovered.resolve(JSON.parse(body));
            response.writeHead(204).end();
          } else {
            response.writeHead(404).end();
          }
        })().catch((error: unknown) => response.writeHead(500).end(String(error)));
      });
      const serverUrl = await listenLoopback(server);
      resources.defer(() => closeHttpServer(server));
      const nodeExecutable = resolveTestNodeExecPath();
      const gatewayPrefix = [nodeExecutable];
      const instance = await createOpenClawTestInstance({
        name: "postgres-final-receipt-crash",
        signal,
        entrypoint: resolveRuntimeWorkerArgv(
          resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli),
          nodeExecutable,
        ),
        gatewayCommandPrefix: gatewayPrefix,
        env: {
          [DSN_ENV]: connection,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_GATEWAY_RESTART_TRACE: "0",
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_NO_RESPAWN: "1",
          NODE_DISABLE_COMPILE_CACHE: "1",
        },
        config: {
          database: {
            engine: "postgres",
            postgres: {
              connection: { source: "env", provider: "default", id: DSN_ENV },
              schemaPrefix: PREFIX,
            },
          },
          gateway: { mode: "local" },
          skills: { load: { watch: false } },
        },
      });
      resources.defer(() => instance.cleanup());
      state = instance.state;
      const current = instance.state;
      current.applyEnv();
      const sinkPlugin = await writeSinkPlugin(current.workspaceDir, `${serverUrl}/sink`);
      const config: OpenClawConfig = {
        ...JSON.parse(await fs.readFile(current.configPath, "utf8")),
        agents: {
          defaults: {
            workspace: current.workspaceDir,
            skipBootstrap: true,
          },
          entries: { main: {} },
        },
        plugins: {
          allow: ["provenance-sink"],
          entries: { "provenance-sink": { enabled: true } },
          load: { paths: [sinkPlugin] },
          slots: { memory: "none" },
        },
        channels: {
          telegram: {
            enabled: true,
            botToken: "123456:isolated-proof",
            dmPolicy: "open",
            allowFrom: ["*"],
          },
        },
      };
      await current.writeConfig(config);
      delete instance.env.VITEST;
      delete instance.env.NODE_ENV;
      // Preflight owns migration completion; full runtime bootstrap belongs to the real Gateways.
      const preflight = await runStartupConfigPreflight({ gateway: true, observe: false });
      try {
        expect(preflight.snapshot.valid).toBe(true);
      } finally {
        await preflight.pluginCache?.[Symbol.asyncDispose]();
      }
      await closeOpenClawAgentDatabasesAsync(current.stateDir);
      await closeStateDatabaseForTest();
      const bootstrapAnchor = await readPostgresAnchor(current);
      if (!bootstrapAnchor) {
        throw new Error("Gateway startup did not persist its PostgreSQL anchor");
      }
      expect(
        await queryRows(
          `SELECT value_json FROM ${quoteIdentifier(bootstrapAnchor.namespace)}.config_machine_state WHERE state_key = $1`,
          [`webhookListeners:${current.configPath}`],
        ),
      ).toEqual([{ value_json: "true" }]);
      await installGatewayDatabaseEngine(preflight.snapshot, preflight.databaseEngineSelection);
      const sessionKey = "agent:main:final-receipt-crash";
      const target = "provenance-final-receipt-crash";
      const scope = {
        agentId: "main",
        sessionKey,
        storePath: resolveOpenClawAgentSqlitePath({ agentId: "main", env: current.env }),
      };
      const payloads = [{ text: summary }];
      const context = { channel: "telegram", to: target, accountId: "default" };
      const source: InternalSessionEntry = {
        sessionId: "final-receipt-crash",
        updatedAt: Date.now(),
        ...(noticeCrash
          ? {
              delivery: {
                kind: "external" as const,
                route: { channel: "telegram", accountId: "default" },
                context,
                origin: {},
              },
            }
          : {}),
      };
      // Seed produced output through real workers; Gateway startup owns both transport settlements.
      await replaceSessionEntry(scope, source);
      await markFinal(scope, source, payloads, context);
      const completion = resolvePendingFinalDeliveryCompletion(payloads);
      if (!completion) {
        throw new Error("Missing queued pending-final completion");
      }
      await enqueueDeliveryOnce(
        { ...context, payloads, deliveryCompletion: completion, requiresProducerClaim: true },
        completion.deliveryId,
        current.stateDir,
      );
      // Seed uncertain answer custody through its worker owner. The earlier windows
      // prove remote answer acceptance; this case sends only the recovery notice.
      if (noticeCrash) {
        await markDeliveryPlatformOutcomeUnknown(completion.deliveryId, current.stateDir);
      }
      await closeOpenClawAgentDatabasesAsync(current.stateDir);
      await closeStateDatabaseForTest();
      const noticeId = `main-session-restart-recovery:pending-final:${completion.intentId}`;
      gatewayPrefix.push(
        "--import",
        createDeliveryCrashPreload({ window, id: completion.deliveryId, noticeId, serverUrl }),
      );
      await instance.startGateway();
      const firstChild = instance.child!;
      const boundary = await withinTest(held.promise, signal);
      expect(boundary.pid).toBe(firstChild.pid);
      expect(boundary.id).toBe(completion.deliveryId);
      const anchor = await readPostgresAnchor(current);
      const agentAnchor = await readPostgresAnchor(
        current,
        resolveOpenClawAgentSqlitePath({ agentId: "main", env: current.env }),
      );
      if (!anchor || !agentAnchor) {
        throw new Error("Gateway final delivery did not persist both PostgreSQL anchors");
      }
      const reader = createDeliveryCrashReader(
        client,
        anchor.namespace,
        agentAnchor.namespace,
        sessionKey,
        boundary.id,
      );
      const { readEntry, readQueue } = reader;
      if (noticeCrash) {
        await recoverNoticeCommitCrash({
          transcriptCommitted: window === "notice-transcript-reply-lost",
          reader,
          instance,
          completion,
          noticeId,
          gatewayPrefix,
          serverUrl,
          recovered: recovered.promise,
          signal,
          deliveries,
          target,
        });
        return;
      }
      const entry = await readEntry();
      expect(entry.sessionId).toEqual(expect.any(String));
      const queue = await readQueue();
      expect(queue).toMatchObject([{ status: "pending" }]);
      const queued: QueuedDelivery = JSON.parse(queue[0]!.entry_json);
      const expected = {
        intentId: expect.any(String),
        deliveries: [
          {
            id: boundary.id,
            state: receiptCommitted ? "delivered" : "queued",
            ...(receiptCommitted
              ? { receipt: { platformMessageId: "accepted-final", resultCount: 1 } }
              : {}),
          },
        ],
      };
      expect(entry.pendingFinalDelivery).toMatchObject(expected);
      if (!receiptCommitted) {
        expect(entry.pendingFinalDelivery?.deliveries?.[0]?.receipt).toBeUndefined();
      }
      expect(queued.recoveryState).toBe(
        window === "response-lost" ? "send_attempt_started" : "unknown_after_send",
      );
      if (window === "response-lost") {
        expect(queued.retryCount).toBe(1);
        expect(queued.lastError).toMatch(/fetch failed/i);
      }
      const identity = entry.pendingFinalDelivery!;
      expect(queued.deliveryCompletion).toMatchObject({
        kind: "pending-final",
        sessionKey,
        sessionId: entry.sessionId,
        intentId: identity.intentId,
        deliveryId: boundary.id,
      });
      expect(deliveries).toMatchObject([{ to: target, text: summary }]);
      expect(deliveries).toHaveLength(1);
      await instance.crashGateway();
      expect(firstChild.signalCode).toBe("SIGKILL");
      expect((await readEntry()).pendingFinalDelivery).toEqual(identity);
      const afterCrash = await readQueue();
      expect(afterCrash).toMatchObject([{ status: "pending" }]);
      const crashed: QueuedDelivery = JSON.parse(afterCrash[0]!.entry_json);
      if (window !== "response-lost") {
        expect(crashed.availableAt).toEqual(expect.any(Number));
      }
      // Advance past the persisted lease and retry deadline without rewriting custody.
      // The heartbeat owner and its worker must observe the same epoch clock.
      gatewayPrefix[2] = createDeliveryCrashPreload({
        window,
        id: boundary.id,
        serverUrl,
        observe: true,
        offset:
          Math.max(
            0,
            (crashed.availableAt ?? 0) - Date.now(),
            (crashed.lastAttemptAt ?? crashed.enqueuedAt) +
              computeBackoffMs(crashed.retryCount) -
              Date.now(),
          ) + 1_000,
      });
      await instance.startGateway();
      const ack = await withinTest(recovered.promise, signal);
      expect(ack).toEqual({ id: boundary.id, pid: instance.child?.pid });
      expect(ack.pid).not.toBe(firstChild.pid);
      const settledEntry = await readEntry();
      if (receiptCommitted) {
        expect(await readQueue()).toEqual([]);
        expect(settledEntry.pendingFinalDelivery).toEqual(identity);
      } else {
        const failed = await readQueue();
        expect(failed).toMatchObject([{ status: "failed" }]);
        expect(JSON.parse(failed[0]!.entry_json)).toMatchObject({
          id: boundary.id,
          completionRetention: "permanent",
          recoveryState: "completed_permanent",
        });
        expect(settledEntry.pendingFinalDelivery).toMatchObject({
          ...identity,
          deliveries: [{ id: boundary.id, state: "unknown" }],
        });
        expect(settledEntry.pendingFinalDelivery?.deliveries?.[0]?.receipt).toBeUndefined();
        expect(settledEntry.pendingDeliveryNotice).toMatchObject({
          intentId: identity.intentId,
          state: "owed",
        });
      }
      await instance.stopGateway();
      expect(deliveries).toHaveLength(1);
    },
  );

  it("refuses existing SQLite data and directs the operator to the port command", async () => {
    const current = await fixture();
    const pathname = resolveOpenClawStateSqlitePath(current.env);
    await fs.mkdir(current.statePath("state"), { recursive: true });
    {
      using original = openNodeSqliteDatabase(pathname);
      original.exec("CREATE TABLE existing_data (value TEXT NOT NULL)");
      original.prepare("INSERT INTO existing_data (value) VALUES (?)").run("preserved");
    }

    await expect(bootstrap()).rejects.toThrow(/existing SQLite[\s\S]*openclaw database port/iu);
    await closeStateDatabaseForTest();
    expect(await readPostgresAnchor(current)).toBeUndefined();
    using unchanged = openNodeSqliteDatabase(pathname, { readOnly: true });
    expect(unchanged.prepare("SELECT value FROM existing_data").all()).toEqual([
      { value: "preserved" },
    ]);
  });

  it("acquires, renews, publishes, and releases Gateway ownership in PostgreSQL", async () => {
    const { current, snapshot, anchor } = await bootstrapped();
    const claim = await acquireTestPortBlock({ offsets: [0] });
    await using claims = new AsyncDisposableStack();
    claims.defer(claim.release);
    await installGatewayDatabaseEngine(snapshot);
    // Acquisition awaits the real heartbeat worker's initial durable renewal.
    const lock = await acquireGatewayLock({
      env: current.env,
      port: claim.port,
      listenerMode: "foreground",
      allowInTests: true,
    });
    if (!lock) {
      throw new Error("Gateway ownership was not acquired");
    }
    try {
      lock.markListening?.();
      const lease = await queryRows<Record<"payload_json" | "heartbeat_at" | "expires_at", string>>(
        `SELECT payload_json, heartbeat_at, expires_at FROM ${quoteIdentifier(anchor.namespace)}.state_leases WHERE scope = $1 AND lease_key = $2`,
        ["gateway-owner", "global"],
      );
      expect(lease).toHaveLength(1);
      const row = lease[0]!;
      expect(JSON.parse(row.payload_json)).toMatchObject({
        port: claim.port,
        mode: "foreground",
        listeningAt: expect.any(Number),
      });
      expect(Number(row.heartbeat_at)).toBeGreaterThan(0);
      expect(Number(row.expires_at)).toBeGreaterThan(Date.now());
    } finally {
      await lock.release();
    }
    const released = await queryRows(
      `SELECT owner FROM ${quoteIdentifier(anchor.namespace)}.state_leases WHERE scope = $1 AND lease_key = $2`,
      ["gateway-owner", "global"],
    );
    expect(released).toEqual([]);
  });

  it.each([
    ["invalid DSN", "postgresql://[invalid"],
    ["refused connection", "postgresql://127.0.0.1:1/unreachable?connect_timeout=1"],
  ])("fails loudly for %s without creating SQLite state", async (_label, dsn) => {
    const current = await fixture(dsn);
    await expect(bootstrap()).rejects.toThrow(
      /postgres|connection|connect|invalid URL|ECONNREFUSED/iu,
    );
    await closeStateDatabaseForTest();
    // A failed PG connection may persist its anchor, but must not initialize SQLite state.
    await readPostgresAnchor(current);
  });
});
