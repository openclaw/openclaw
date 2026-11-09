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
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { cliRecoveryEntrypoints } from "../cli/cli-entrypoint.test-support.js";
import { runCliProcessChild } from "../cli/cli-process-child.test-helpers.js";
import { runStartupConfigPreflight } from "../commands/startup-config-preflight.js";
import { resetConfigRuntimeState } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import { migrateLegacyDesktopStreamOptOuts } from "../infra/device-pairing-node-desktop-migration.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { dropPostgresTestSchemas } from "../infra/postgres-sync/schema-cleanup.test-support.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { resetLogger } from "../logging/logger.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { withSecureTestNodeCommand } from "../secrets/test-node-command.test-support.js";
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
import type { toCronBroadcastEvent } from "./server-cron-plugin-job.js";
import { installGatewayDatabaseEngine } from "./server-database-engine.js";
import { prepareGatewayServerBootstrap } from "./server-startup-bootstrap.js";
import { loadGatewayWorkerEnvironmentStartupState } from "./server-worker-environment-startup.js";
import { createWorkerStartupRuntime } from "./server-worker-environment-startup.runtime.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const DSN_ENV = "OPENCLAW_PGPREP_BOOTSTRAP_DSN";
const PREFIX = `pgprep_boot_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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
  async function bootstrapped(execCommand?: string) {
    const current = await fixture(connection, execCommand);
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
      expect(await readAnchor(current)).toEqual(anchor);
      const persisted = await queryRows(
        `SELECT value_json FROM ${quoteIdentifier(anchor.namespace)}.config_machine_state WHERE state_key = $1`,
        ["tts.prefsPath"],
      );
      expect(persisted).toEqual([{ value_json: JSON.stringify(PREFS_PATH) }]);
    }));

  it(
    "keeps a completed retained one-shot disabled across a scheduler-enabled Gateway restart",
    { timeout: 90_000 },
    async ({ signal }) => {
      const current = await fixture();
      Object.assign(current.envVars, {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      });
      current.applyEnv();
      const prompt = "Report the retained one-shot result.";
      const summary = "Retained one-shot completed.";
      const requests: string[] = [];
      await using resources = new AsyncDisposableStack();
      const providerServer = createServer((request, response) => {
        void (async () => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          requests.push(await readRequestText(request));
          writeOpenAiResponsesText(response, {
            text: summary,
            messageId: "retained-one-shot-message",
            responseId: "retained-one-shot-response",
          });
        })().catch((error: unknown) => {
          response.writeHead(500).end(String(error));
        });
      });
      const providerUrl = await listenLoopback(providerServer);
      resources.defer(() => closeHttpServer(providerServer));
      const provider = buildMockOpenAiResponsesProvider(`${providerUrl}/v1`);
      const config: OpenClawConfig = {
        ...JSON.parse(await fs.readFile(current.configPath, "utf8")),
        agents: {
          defaults: {
            workspace: current.workspaceDir,
            skipBootstrap: true,
            model: { primary: provider.modelRef },
            models: {
              [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
            },
          },
          entries: { main: {} },
        },
        models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
        cron: { enabled: true },
      };
      await using firstGateway = new AsyncDisposableStack();
      const gateway = await startGatewayWithClient({
        cfg: config,
        configPath: current.configPath,
        token: "postgres-bootstrap-synthetic-token",
        clientDisplayName: "vitest-postgres-cron",
      });
      firstGateway.defer(() => gateway.server.close({ reason: "PostgreSQL cron restart" }));
      firstGateway.defer(() => disconnectGatewayClient(gateway.client));
      const job = await gateway.client.request<{ id: string }>("cron.add", {
        name: "retained-one-shot",
        agentId: "main",
        enabled: true,
        deleteAfterRun: false,
        // Automatic dispatch stays disabled; a due occurrence belongs to this manual run.
        schedule: { kind: "at", at: new Date(Date.now() - 1_000).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: prompt },
        delivery: { mode: "none" },
      });
      const run = await gateway.client.request<{ runId: string }>(
        "cron.run",
        { id: job.id, mode: "force", waitTimeoutMs: 30_000 },
        { timeoutMs: 35_000 },
      );
      expect(run).toMatchObject({
        enqueued: true,
        run: { status: "ok", completionStatus: "succeeded", summary },
      });
      await expect(
        gateway.client.request("cron.runs", { id: job.id, runId: run.runId, limit: 1 }),
      ).resolves.toMatchObject({
        entries: [{ runId: run.runId, status: "ok", completionStatus: "succeeded", summary }],
      });
      await expect(gateway.client.request("cron.get", { id: job.id })).resolves.toMatchObject({
        id: job.id,
        enabled: false,
      });
      await firstGateway.disposeAsync();
      await closeStateDatabaseForTest();
      const anchor = await readAnchor(current);
      if (!anchor) {
        throw new Error("Gateway cron did not persist its PostgreSQL anchor");
      }
      clearSecretsRuntimeSnapshot();
      resetConfigRuntimeState();
      resetDatabaseEngineSelectionForTest();
      current.envVars.OPENCLAW_SKIP_CRON = "0";
      current.applyEnv();

      const probePrompt = "Report the automatic scheduler probe result.";
      type BroadcastEvent = ReturnType<typeof toCronBroadcastEvent>;
      const probeFinished = createDeferred<BroadcastEvent>();
      const finishedEvents = new Map<string, BroadcastEvent>();
      let probeId: string | undefined;
      await using secondGateway = new AsyncDisposableStack();
      const restarted = await startGatewayWithClient({
        cfg: config,
        configPath: current.configPath,
        token: "postgres-bootstrap-synthetic-token",
        clientDisplayName: "vitest-postgres-cron-restarted",
        onEvent: ({ event, payload }) => {
          if (event !== "cron") {
            return;
          }
          const cronEvent = payload as BroadcastEvent;
          if (cronEvent.action === "finished") {
            finishedEvents.set(cronEvent.jobId, cronEvent);
            if (cronEvent.jobId === probeId) {
              probeFinished.resolve(cronEvent);
            }
          }
        },
      });
      secondGateway.defer(() =>
        restarted.server.close({ reason: "PostgreSQL cron restart proof complete" }),
      );
      secondGateway.defer(() => disconnectGatewayClient(restarted.client));
      await restarted.server.startupSettled;
      await expect(restarted.client.request("cron.status", {})).resolves.toMatchObject({
        enabled: true,
      });
      // An automatically completed due job proves the new scheduler generation ran;
      // startupSettled alone does not join the detached cron startup task.
      const probe = await restarted.client.request<{ id: string }>("cron.add", {
        name: "automatic-scheduler-probe",
        agentId: "main",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date(Date.now() - 1_000).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: probePrompt },
        delivery: { mode: "none" },
      });
      probeId = probe.id;
      // The broadcast may precede the cron.add response on the same connection.
      const alreadyFinished = finishedEvents.get(probe.id);
      if (alreadyFinished) {
        probeFinished.resolve(alreadyFinished);
      }
      expect(await withinTest(probeFinished.promise, signal)).toMatchObject({
        jobId: probe.id,
        status: "ok",
        completionStatus: "succeeded",
      });
      await expect(
        restarted.client.request("cron.runs", { id: probe.id, limit: 1 }),
      ).resolves.toMatchObject({
        entries: [{ status: "ok", completionStatus: "succeeded", summary }],
      });
      await expect(restarted.client.request("cron.get", { id: job.id })).resolves.toMatchObject({
        id: job.id,
        enabled: false,
      });
      const history = await restarted.client.request<{ entries: unknown[] }>("cron.runs", {
        id: job.id,
        limit: 10,
      });
      expect(history.entries).toEqual([
        expect.objectContaining({ runId: run.runId, status: "ok", completionStatus: "succeeded" }),
      ]);
      await secondGateway.disposeAsync();
      await closeStateDatabaseForTest();
      expect(await readAnchor(current)).toEqual(anchor);
      expect(requests.filter((body) => body.includes(prompt))).toHaveLength(1);
      expect(requests.filter((body) => body.includes(probePrompt))).toHaveLength(1);
      const jobs = await queryRows<{ enabled: string; job_json: string }>(
        `SELECT enabled, job_json FROM ${quoteIdentifier(anchor.namespace)}.cron_jobs WHERE job_id = $1`,
        [job.id],
      );
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.enabled).toBe("0");
      expect(JSON.parse(jobs[0]!.job_json)).toMatchObject({ id: job.id, enabled: false });
      const runs = await queryRows<{
        status: string;
        terminal_summary: string;
        detail_json: string;
      }>(
        `SELECT status, terminal_summary, detail_json FROM ${quoteIdentifier(anchor.namespace)}.task_runs WHERE runtime = 'cron' AND source_id = $1`,
        [job.id],
      );
      expect(runs).toEqual([
        { status: "succeeded", terminal_summary: summary, detail_json: expect.any(String) },
      ]);
      expect(JSON.parse(runs[0]!.detail_json)).toMatchObject({ runId: run.runId });
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
