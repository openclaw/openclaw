import fs from "node:fs/promises";
import { getEnvironmentData } from "node:worker_threads";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runStartupConfigPreflight } from "../commands/startup-config-preflight.js";
import { resetConfigRuntimeState } from "../config/runtime-snapshot.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import { migrateLegacyDesktopStreamOptOuts } from "../infra/device-pairing-node-desktop-migration.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { resetLogger } from "../logging/logger.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../state/openclaw-state-worker-store.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { createDesktopSessionRegistry } from "./desktop/session-registry.js";
import { installGatewayDatabaseEngine } from "./server-database-engine.js";
import { prepareGatewayServerBootstrap } from "./server-startup-bootstrap.js";
import {
  createGatewayWorkerEnvironmentRuntime,
  loadGatewayWorkerEnvironmentStartupState,
} from "./server-worker-environment-startup.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const DSN_ENV = "OPENCLAW_PGPREP_BOOTSTRAP_DSN";
const PREFIX = "pgprep_boot";
const PREFS_PATH = "/synthetic/postgres-bootstrap";

type Anchor = { storeId: string; namespace: string };

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function readAnchor(state: OpenClawTestState): Promise<Anchor | undefined> {
  const pathname = resolveOpenClawStateSqlitePath(state.env);
  try {
    await fs.stat(pathname);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  using db = openNodeSqliteDatabase(pathname, { readOnly: true });
  const sqliteState = db.prepare(
    "SELECT name FROM sqlite_master WHERE name IN ('schema_meta', 'config_machine_state')",
  );
  expect(sqliteState.all()).toEqual([]);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'openclaw_engine_anchor'").get()) {
    return undefined;
  }
  const rows = db.prepare("SELECT store_id, engine, schema FROM openclaw_engine_anchor").all();
  expect(rows).toHaveLength(1);
  const row = rows[0];
  expect(row?.engine).toBe("postgres");
  if (typeof row?.store_id !== "string" || typeof row.schema !== "string") {
    throw new Error("PostgreSQL bootstrap did not persist a complete anchor identity");
  }
  return { storeId: row.store_id, namespace: row.schema };
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
  async function bootstrapped() {
    const current = await fixture();
    const snapshot = await bootstrap();
    await closeStateDatabaseForTest();
    const anchor = await readAnchor(current);
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
      const anchor = state && (await readAnchor(state));
      if (anchor) {
        await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(anchor.namespace)} CASCADE`);
      }
    } finally {
      await state?.cleanup();
      state = undefined;
      resetLogger();
      resetDatabaseEngineSelectionForTest();
    }
  });

  async function fixture(dsn = connection ?? ""): Promise<OpenClawTestState> {
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
          connection: { source: "env", provider: "default", id: DSN_ENV },
          schemaPrefix: PREFIX,
        },
      },
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

  it("opens PostgreSQL through preflight and bootstrap, captures workers' input, and reuses the anchor on restart", async () => {
    const { current, snapshot, anchor } = await bootstrapped();
    expect(anchor.namespace).toMatch(/^pgprep_boot_state_[a-f0-9]{16}$/u);
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
      const runtime = await createGatewayWorkerEnvironmentRuntime({
        scheduler: createTestGatewayScheduler(),
        getPluginRegistry: () => registry,
        getPortalRuntime: () => undefined,
        resolveGatewayContext: () => undefined,
        desktopSessionRegistry: createDesktopSessionRegistry(),
        startup: workers,
        log: { child: () => ({ info: () => {}, warn: () => {} }) },
      });
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
    });
    await closeStateDatabaseForTest();
    clearSecretsRuntimeSnapshot();
    resetConfigRuntimeState();

    await bootstrap();
    await closeStateDatabaseForTest();
    expect(await readAnchor(current)).toEqual(anchor);
    const persisted = await queryRows(
      `SELECT value_json FROM ${quoteIdentifier(anchor.namespace)}.config_machine_state WHERE state_key = $1`,
      ["tts.prefsPath"],
    );
    expect(persisted).toEqual([{ value_json: JSON.stringify(PREFS_PATH) }]);
  });

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
    expect(await readAnchor(current)).toBeUndefined();
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
    await readAnchor(current);
  });
});
