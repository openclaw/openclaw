import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { stripVTControlCharacters } from "node:util";
import { getEnvironmentData } from "node:worker_threads";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
  readRequestText,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { cliRecoveryEntrypoints } from "../cli/cli-entrypoint.test-support.js";
import { resetConfigRuntimeState } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJob } from "../cron/types.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import { dropPostgresTestSchemas } from "../infra/postgres-sync/schema-cleanup.test-support.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { resetLogger } from "../logging/logger.js";
import { clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { toCronBroadcastEvent } from "./server-cron-plugin-job.js";
import { readPostgresAnchor } from "./server-database-engine-delivery-crash.test-support.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const DSN_ENV = "OPENCLAW_PGPREP_BOOTSTRAP_DSN";
const PREFIX = `pgprep_cron_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

describe.skipIf(!connection)("Gateway PostgreSQL cron lifecycle", () => {
  const client = new pg.Client({ connectionString: connection });
  let state: OpenClawTestState | undefined;

  beforeAll(() => client.connect());
  afterAll(() => client.end());

  async function queryRows<T extends pg.QueryResultRow>(sql: string, values: unknown[]) {
    return (await client.query<T>(sql, values)).rows;
  }

  afterEach(async () => {
    clearSecretsRuntimeSnapshot();
    resetConfigRuntimeState();
    await closeStateDatabaseForTest();
    try {
      // Real agent turns also create agent namespaces; drain both owners before dropping schemas.
      await state?.restoreEnv();
      await dropPostgresTestSchemas(client, PREFIX);
    } finally {
      await state?.cleanup();
      state = undefined;
      resetLogger();
      resetDatabaseEngineSelectionForTest();
    }
  });

  async function startCronGateway(
    resources: AsyncDisposableStack,
    signal: AbortSignal,
    providerUrl: string,
  ) {
    const nodeExecutable = resolveTestNodeExecPath();
    const applicationName = `gateway-cron-stop-${randomUUID()}`;
    const gatewayConnection = new URL(connection!);
    gatewayConnection.searchParams.set("application_name", applicationName);
    const instance = await createOpenClawTestInstance({
      name: "postgres-retained-cron",
      signal,
      entrypoint: resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli),
        nodeExecutable,
      ),
      gatewayCommandPrefix: [nodeExecutable],
      env: {
        [DSN_ENV]: connection,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_GATEWAY_RESTART_TRACE: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        // Kill the Gateway owner itself, rather than a CLI respawn wrapper.
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
        plugins: { enabled: false },
        skills: { load: { watch: false } },
      },
    });
    resources.defer(() => instance.cleanup());
    // Tag only child connections; fixture-side observers must survive its shutdown.
    instance.env[DSN_ENV] = gatewayConnection.href;
    const current = instance.state;
    state = current;
    current.applyEnv();
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
    await current.writeConfig(config);
    // Only the child leaves test mode so it acquires the real Gateway owner lease.
    delete instance.env.VITEST;
    delete instance.env.NODE_ENV;
    await instance.startGateway();
    const firstBoot = createDeferred<string | undefined>();
    const closed = createDeferred<{ code: number; reason: string }>();
    const gateway = await connectGatewayClient({
      url: instance.url,
      token: instance.gatewayToken,
      clientDisplayName: "vitest-postgres-cron",
      signal,
      onHelloOk: (hello) => firstBoot.resolve(hello.server.bootId),
      onClose: (code, reason) => closed.resolve({ code, reason }),
    });
    resources.defer(() => disconnectGatewayClient(gateway));
    const anchor = await readPostgresAnchor(current);
    if (!anchor) {
      throw new Error("Gateway cron did not persist its PostgreSQL anchor");
    }
    const ownedBackends = () =>
      queryRows<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE application_name = $1 ORDER BY pid",
        [applicationName],
      );
    return {
      instance,
      current,
      gateway,
      anchor,
      applicationName,
      ownedBackends,
      bootId: await firstBoot.promise,
      closed: closed.promise,
    };
  }

  it(
    "joins interrupted cron finalization before restarting in process and reuses its PostgreSQL pool",
    { timeout: 90_000 },
    async ({ signal }) => {
      await using resources = new AsyncDisposableStack();
      const prompt = "Report the interrupted in-process restart result.";
      const probePrompt = "Report the result after the in-process restart.";
      const summary = "Post-restart cron completed.";
      const accepted = createDeferred();
      const aborted = createDeferred();
      const requests: string[] = [];
      const providerServer = createServer((request, response) => {
        void (async () => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          requests.push(await readRequestText(request));
          if (requests.length === 1) {
            response.once("close", () => {
              if (!response.writableEnded) {
                aborted.resolve();
              }
            });
            // Only restart cancellation may release this response. Replays finish visibly.
            accepted.resolve();
            return;
          }
          writeOpenAiResponsesText(response, {
            text: summary,
            messageId: "post-restart-cron-message",
            responseId: "post-restart-cron-response",
          });
        })().catch((error: unknown) => {
          response.writeHead(500).end(String(error));
        });
      });
      const providerUrl = await listenLoopback(providerServer);
      resources.defer(() => closeHttpServer(providerServer));
      const { instance, gateway, anchor, applicationName, ownedBackends, bootId, closed } =
        await startCronGateway(resources, signal, providerUrl);
      const child = instance.child!;
      const pid = child.pid!;
      expect(bootId).toEqual(expect.any(String));
      const readBridgeStarts = () => {
        const logs = stripVTControlCharacters(instance.logs());
        return [...logs.matchAll(/worker startup state: (\{[^\r\n]*\})\r?\n/gu)].map((match) => {
          const snapshot: {
            workerLifecycle: Array<{
              script: string;
              started: number;
              retired: Array<{ reason: string; count: number }>;
            }>;
          } = JSON.parse(match[1]!);
          return snapshot.workerLifecycle.filter(({ script }) => script === "bridge.worker.js");
        });
      };
      const pool = { postgresBridgeCount: 4, postgresPoolSelfRootCount: 0 };
      const bridge = [{ script: "bridge.worker.js", started: 4, retired: [] }];
      await expect(gateway.request("diagnostics.lanes", {})).resolves.toMatchObject(pool);
      await expect.poll(readBridgeStarts).toEqual([bridge]);
      const job = await gateway.request<{ id: string }>("cron.add", {
        name: "in-process-restart-one-shot",
        agentId: "main",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date(Date.now() - 1_000).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: prompt },
        delivery: { mode: "none" },
      });
      const run = await gateway.request<{ runId: string }>("cron.run", {
        id: job.id,
        mode: "force",
      });
      expect(run).toMatchObject({ enqueued: true, runId: expect.any(String) });
      await withinTest(accepted.promise, signal);
      const readReceipt = () =>
        queryRows<{ receipt_id: string; status: string }>(
          `SELECT receipt_id, status FROM ${quoteIdentifier(anchor.namespace)}.cron_run_receipts WHERE request_run_id = $1`,
          [run.runId],
        );
      const receipts = await readReceipt();
      expect(receipts).toEqual([{ receipt_id: expect.any(String), status: "running" }]);
      const locker = new pg.Client({ connectionString: connection });
      resources.defer(() => locker.end());
      await locker.connect();
      await locker.query("BEGIN");
      // Register rollback last so failed assertions unlock before Gateway cleanup joins writes.
      const lock = resources.use(new AsyncDisposableStack());
      lock.defer(() => locker.query("ROLLBACK").then(() => undefined));
      await locker.query(
        `SELECT receipt_id FROM ${quoteIdentifier(anchor.namespace)}.cron_run_receipts WHERE receipt_id = $1 FOR UPDATE`,
        [receipts[0]!.receipt_id],
      );
      const lockerPid = (await locker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0]!.pid;
      const blockedBackends = () =>
        queryRows<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND query ILIKE '%UPDATE%cron_run_receipts%' AND $2 = ANY(pg_blocking_pids(pid)) ORDER BY pid",
          [applicationName, lockerPid],
        );
      // The provider is still running: restart-intent consumption must precede finalization.
      const restart = await gateway.request<{ preflight: { counts: { cronRuns: number } } }>(
        "gateway.restart.request",
        { skipDeferral: true, reason: "postgres-cron-in-process-test" },
      );
      expect(restart).toMatchObject({ ok: true, status: "scheduled" });
      expect(restart.preflight.counts.cronRuns).toBeGreaterThan(0);
      await withinTest(aborted.promise, signal);
      await expect
        .poll(blockedBackends, { timeout: 15_000 })
        .toEqual([{ pid: expect.any(Number) }]);
      // Ingress retires after cron's grace window, before the retained finalizer joins.
      await expect(withinTest(closed, signal)).resolves.toEqual({
        code: 1012,
        reason: "service restart",
      });
      expect(await readReceipt()).toEqual(receipts);
      expect(await blockedBackends()).toHaveLength(1);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(readBridgeStarts()).toEqual([bridge]);
      await lock.disposeAsync();
      await disconnectGatewayClient(gateway);
      await expect
        .poll(
          async () => {
            try {
              const response = await fetch(`http://127.0.0.1:${instance.port}/startupz`, {
                headers: {
                  "x-openclaw-startup-boot-id": "1",
                },
                signal,
              });
              const body: { gatewayBootId?: string } = await response.json();
              return {
                status: response.status,
                changed: Boolean(body.gatewayBootId && body.gatewayBootId !== bootId),
              };
            } catch {
              // The old listener closes before the next in-process boot opens it.
              return undefined;
            }
          },
          { timeout: 30_000 },
        )
        .toEqual({ status: 200, changed: true });
      const nextBoot = createDeferred<string | undefined>();
      const restarted = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        clientDisplayName: "vitest-postgres-cron-in-process",
        signal,
        onHelloOk: (hello) => nextBoot.resolve(hello.server.bootId),
      });
      resources.defer(() => disconnectGatewayClient(restarted));
      const nextBootId = await nextBoot.promise;
      expect(nextBootId).toEqual(expect.any(String));
      expect(nextBootId).not.toBe(bootId);
      expect(instance.child).toBe(child);
      expect(child.pid).toBe(pid);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(
        (
          await fetch(`http://127.0.0.1:${instance.port}/readyz`, {
            headers: { authorization: `Bearer ${instance.gatewayToken}` },
            signal,
          })
        ).status,
      ).toBe(200);
      // Live count alone would also pass if all four services had been replaced.
      await expect.poll(readBridgeStarts).toEqual([bridge, bridge]);
      await expect(restarted.request("diagnostics.lanes", {})).resolves.toMatchObject(pool);
      expect(await readReceipt()).toEqual([
        { receipt_id: receipts[0]!.receipt_id, status: "interrupted" },
      ]);
      await expect(
        restarted.request("cron.runs", { id: job.id, limit: 10 }),
      ).resolves.toMatchObject({
        entries: [{ runId: run.runId, status: "error", completionStatus: "failed" }],
      });
      const retiredJob = await restarted.request<CronJob>("cron.get", { id: job.id });
      expect(retiredJob.state.runningAtMs).toBeUndefined();
      const probe = await restarted.request<{ id: string }>("cron.add", {
        name: "after-in-process-restart",
        agentId: "main",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date(Date.now() - 1_000).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: probePrompt },
        delivery: { mode: "none" },
      });
      await expect(
        restarted.request(
          "cron.run",
          { id: probe.id, mode: "force", waitTimeoutMs: 30_000 },
          { timeoutMs: 35_000 },
        ),
      ).resolves.toMatchObject({
        enqueued: true,
        run: { status: "ok", completionStatus: "succeeded", summary },
      });
      await disconnectGatewayClient(restarted);
      const exited = once(child, "exit");
      process.kill(pid, "SIGINT");
      expect(await withinTest(exited, signal)).toEqual([0, null]);
      await instance.stopGateway();
      await expect.poll(ownedBackends).toEqual([]);
      expect(requests.filter((body) => body.includes(prompt))).toHaveLength(1);
      expect(requests.filter((body) => body.includes(probePrompt))).toHaveLength(1);
      const runs = await queryRows<{ status: string; detail_json: string }>(
        `SELECT status, detail_json FROM ${quoteIdentifier(anchor.namespace)}.task_runs WHERE runtime = 'cron' AND source_id = $1`,
        [job.id],
      );
      expect(runs).toEqual([{ status: "failed", detail_json: expect.any(String) }]);
      expect(JSON.parse(runs[0]!.detail_json)).toMatchObject({ runId: run.runId });
    },
  );

  it(
    "drains accepted cron finalization before graceful stop and preserves it on restart",
    { timeout: 90_000 },
    async ({ signal }) => {
      await using resources = new AsyncDisposableStack();
      const prompt = "Report the gracefully retained one-shot result.";
      const summary = "Gracefully retained one-shot completed.";
      const completeResponse = createDeferred<() => void>();
      const requests: string[] = [];
      const providerServer = createServer((request, response) => {
        void (async () => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          requests.push(await readRequestText(request));
          const complete = () =>
            writeOpenAiResponsesText(response, {
              text: summary,
              messageId: "graceful-one-shot-message",
              responseId: "graceful-one-shot-response",
            });
          if (requests.length === 1) {
            completeResponse.resolve(complete);
          } else {
            // Complete duplicates so replay produces an observable extra request.
            complete();
          }
        })().catch((error: unknown) => {
          response.writeHead(500).end(String(error));
        });
      });
      const providerUrl = await listenLoopback(providerServer);
      resources.defer(() => closeHttpServer(providerServer));
      const { instance, current, gateway, anchor, applicationName, ownedBackends } =
        await startCronGateway(resources, signal, providerUrl);
      const firstChild = instance.child!;
      const job = await gateway.request<{ id: string }>("cron.add", {
        name: "gracefully-retained-one-shot",
        agentId: "main",
        enabled: true,
        deleteAfterRun: false,
        // Automatic dispatch stays disabled until this manual run is finalized.
        schedule: { kind: "at", at: new Date(Date.now() - 1_000).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: prompt },
        delivery: { mode: "none" },
      });
      const run = await gateway.request<{ runId: string }>("cron.run", {
        id: job.id,
        mode: "force",
      });
      expect(run).toMatchObject({ enqueued: true, runId: expect.any(String) });
      const complete = await withinTest(completeResponse.promise, signal);
      const receipts = await queryRows<{ receipt_id: string; status: string }>(
        `SELECT receipt_id, status FROM ${quoteIdentifier(anchor.namespace)}.cron_run_receipts WHERE request_run_id = $1`,
        [run.runId],
      );
      expect(receipts).toEqual([{ receipt_id: expect.any(String), status: "running" }]);
      const locker = new pg.Client({ connectionString: connection });
      resources.defer(() => locker.end());
      await locker.connect();
      await locker.query("BEGIN");
      const lock = resources.use(new AsyncDisposableStack());
      lock.defer(() => locker.query("ROLLBACK").then(() => undefined));
      await locker.query(
        `SELECT receipt_id FROM ${quoteIdentifier(anchor.namespace)}.cron_run_receipts WHERE receipt_id = $1 FOR UPDATE`,
        [receipts[0]!.receipt_id],
      );
      const lockerPid = (await locker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0]!.pid;
      const blockedBackends = () =>
        queryRows<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND query ILIKE '%UPDATE%cron_run_receipts%' AND $2 = ANY(pg_blocking_pids(pid)) ORDER BY pid",
          [applicationName, lockerPid],
        );
      complete();
      await expect
        .poll(blockedBackends, { timeout: 15_000 })
        .toEqual([{ pid: expect.any(Number) }]);
      const blocked = await blockedBackends();
      expect(blocked).toHaveLength(1);
      const exited = once(firstChild, "exit");
      // SIGINT enters shutdown without a restart-intent read queued behind the held write.
      // Signal the command directly; the fixture adapter's kill cancels its whole tree.
      process.kill(firstChild.pid!, "SIGINT");
      // Readiness shares the retiring HTTP transport, so its draining 503 can be missed.
      // Deliberately cross transport retirement while the accepted finalizer is held:
      // its database owner and original process must survive until the lock is released.
      await expect
        .poll(() => instance.logs(), { timeout: 15_000 })
        .toContain("restart trace: restart.close.http-server ");
      expect(await blockedBackends()).toEqual(blocked);
      expect(firstChild.exitCode).toBeNull();
      expect(firstChild.signalCode).toBeNull();
      expect(() => process.kill(firstChild.pid!, 0)).not.toThrow();
      await lock.disposeAsync();
      expect(await withinTest(exited, signal)).toEqual([0, null]);
      await expect.poll(ownedBackends).toEqual([]);
      expect(
        await queryRows<{ request_run_id: string; status: string }>(
          `SELECT request_run_id, status FROM ${quoteIdentifier(anchor.namespace)}.cron_run_receipts WHERE receipt_id = $1`,
          [receipts[0]!.receipt_id],
        ),
      ).toEqual([{ request_run_id: run.runId, status: "ok" }]);
      await disconnectGatewayClient(gateway);
      await instance.stopGateway();
      instance.env.OPENCLAW_SKIP_CRON = "0";
      await instance.startGateway();
      expect(instance.child?.pid).not.toBe(firstChild.pid);
      const restarted = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        clientDisplayName: "vitest-postgres-cron-after-stop",
        signal,
      });
      resources.defer(() => disconnectGatewayClient(restarted));
      await expect(restarted.request("cron.status", {})).resolves.toMatchObject({ enabled: true });
      await expect(restarted.request("cron.get", { id: job.id })).resolves.toMatchObject({
        id: job.id,
        enabled: false,
      });
      await expect(
        restarted.request("cron.runs", { id: job.id, limit: 10 }),
      ).resolves.toMatchObject({
        entries: [{ runId: run.runId, status: "ok", completionStatus: "succeeded", summary }],
      });
      await disconnectGatewayClient(restarted);
      const lastChild = instance.child!;
      const stopped = once(lastChild, "exit");
      process.kill(lastChild.pid!, "SIGINT");
      expect(await withinTest(stopped, signal)).toEqual([0, null]);
      await instance.stopGateway();
      await expect.poll(ownedBackends).toEqual([]);
      expect(await readPostgresAnchor(current)).toEqual(anchor);
      expect(requests).toHaveLength(1);
      const runs = await queryRows<{ status: string; detail_json: string }>(
        `SELECT status, detail_json FROM ${quoteIdentifier(anchor.namespace)}.task_runs WHERE runtime = 'cron' AND source_id = $1`,
        [job.id],
      );
      expect(runs).toEqual([{ status: "succeeded", detail_json: expect.any(String) }]);
      expect(JSON.parse(runs[0]!.detail_json)).toMatchObject({ runId: run.runId });
    },
  );

  it(
    "recovers completed and interrupted one-shots after their Gateway process is killed",
    { timeout: 90_000 },
    async ({ signal }) => {
      await using resources = new AsyncDisposableStack();
      const prompt = "Report the retained one-shot result.";
      const summary = "Retained one-shot completed.";
      const unfinishedPrompt = "Report the unfinished one-shot result.";
      const accepted = createDeferred();
      let holdUnfinished = true;
      const requests: string[] = [];
      const providerServer = createServer((request, response) => {
        void (async () => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          const body = await readRequestText(request);
          requests.push(body);
          if (holdUnfinished && body.includes(unfinishedPrompt)) {
            holdUnfinished = false;
            // Leave the accepted response open; a duplicate must finish so replay fails visibly.
            accepted.resolve();
            return;
          }
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
      const { instance, current, gateway, anchor, ownedBackends } = await startCronGateway(
        resources,
        signal,
        providerUrl,
      );
      const firstChild = instance.child!;
      const job = await gateway.request<{ id: string }>("cron.add", {
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
      const run = await gateway.request<{ runId: string }>(
        "cron.run",
        { id: job.id, mode: "force", waitTimeoutMs: 30_000 },
        { timeoutMs: 35_000 },
      );
      expect(run).toMatchObject({
        enqueued: true,
        run: { status: "ok", completionStatus: "succeeded", summary },
      });
      await expect(
        gateway.request("cron.runs", { id: job.id, runId: run.runId, limit: 1 }),
      ).resolves.toMatchObject({
        entries: [{ runId: run.runId, status: "ok", completionStatus: "succeeded", summary }],
      });
      await expect(gateway.request("cron.get", { id: job.id })).resolves.toMatchObject({
        id: job.id,
        enabled: false,
      });
      expect(requests.filter((body) => body.includes(prompt))).toHaveLength(1);
      const readOwner = () =>
        queryRows<{ payload_json: string }>(
          `SELECT payload_json FROM ${quoteIdentifier(anchor.namespace)}.state_leases WHERE scope = $1 AND lease_key = $2`,
          ["gateway-owner", "global"],
        );
      const owners = await readOwner();
      expect(owners).toHaveLength(1);
      expect(JSON.parse(owners[0]!.payload_json)).toMatchObject({ owner: { pid: firstChild.pid } });
      const unfinishedJob = await gateway.request<{ id: string }>("cron.add", {
        name: "unfinished-one-shot",
        agentId: "main",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date(Date.now() - 1_000).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: unfinishedPrompt },
        delivery: { mode: "none" },
        failureAlert: { after: 1, cooldownMs: 0 },
      });
      // Omit the completion wait: the process must die with accepted, unfinished work.
      const unfinishedRun = await gateway.request<{ runId: string }>("cron.run", {
        id: unfinishedJob.id,
        mode: "force",
      });
      expect(unfinishedRun).toMatchObject({ enqueued: true, runId: expect.any(String) });
      await withinTest(accepted.promise, signal);
      const activeJob = await gateway.request<CronJob>("cron.get", { id: unfinishedJob.id });
      expect(activeJob).toMatchObject({
        enabled: true,
        state: { runningAtMs: expect.any(Number) },
      });
      const readUnfinishedReceipt = () =>
        queryRows<{
          receipt_id: string;
          request_run_id: string;
          status: string;
          state_json: string;
        }>(
          `SELECT r.receipt_id, r.request_run_id, r.status, j.state_json FROM ${quoteIdentifier(anchor.namespace)}.cron_run_receipts r JOIN ${quoteIdentifier(anchor.namespace)}.cron_jobs j ON j.store_key = r.store_key AND j.job_id = r.job_id WHERE r.job_id = $1`,
          [unfinishedJob.id],
        );
      const activeReceipts = await readUnfinishedReceipt();
      expect(activeReceipts).toHaveLength(1);
      const receipt = {
        receipt_id: activeReceipts[0]!.receipt_id,
        request_run_id: unfinishedRun.runId,
      };
      expect(activeReceipts[0]).toMatchObject({ ...receipt, status: "running" });
      // Public RPCs hide receipt IDs; bind the private marker and receipt in one SQL snapshot.
      expect(JSON.parse(activeReceipts[0]!.state_json)).toMatchObject({
        runningAtMs: activeJob.state.runningAtMs,
        runningReceiptId: receipt.receipt_id,
      });
      await instance.crashGateway();
      expect(firstChild.signalCode).toBe("SIGKILL");
      await disconnectGatewayClient(gateway);
      instance.env.OPENCLAW_SKIP_CRON = "0";
      await instance.startGateway();
      expect(instance.child?.pid).not.toBe(firstChild.pid);
      const newOwners = await readOwner();
      expect(newOwners).toHaveLength(1);
      expect(JSON.parse(newOwners[0]!.payload_json)).toMatchObject({
        owner: { pid: instance.child?.pid },
      });

      const probePrompt = "Report the automatic scheduler probe result.";
      type BroadcastEvent = ReturnType<typeof toCronBroadcastEvent>;
      const probeFinished = createDeferred<BroadcastEvent>();
      const finishedEvents = new Map<string, BroadcastEvent>();
      const probeState: { id?: string } = {};
      const restarted = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        signal,
        clientDisplayName: "vitest-postgres-cron-restarted",
        onEvent: ({ event, payload }) => {
          if (event !== "cron") {
            return;
          }
          const cronEvent = payload as BroadcastEvent;
          if (cronEvent.action === "finished") {
            finishedEvents.set(cronEvent.jobId, cronEvent);
            if (cronEvent.jobId === probeState.id) {
              probeFinished.resolve(cronEvent);
            }
          }
        },
      });
      resources.defer(() => disconnectGatewayClient(restarted));
      await expect(restarted.request("cron.status", {})).resolves.toMatchObject({
        enabled: true,
      });
      // A due slot created after cron.status proves this scheduler generation ran.
      // Backdating it can invoke downtime catch-up instead of a fresh dispatch.
      const probe = await restarted.request<{ id: string }>("cron.add", {
        name: "automatic-scheduler-probe",
        agentId: "main",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date().toISOString() },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: probePrompt },
        delivery: { mode: "none" },
      });
      probeState.id = probe.id;
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
        restarted.request("cron.runs", { id: probe.id, limit: 1 }),
      ).resolves.toMatchObject({
        entries: [{ status: "ok", completionStatus: "succeeded", summary }],
      });
      await expect(restarted.request("cron.get", { id: job.id })).resolves.toMatchObject({
        id: job.id,
        enabled: false,
      });
      const history = await restarted.request<{ entries: unknown[] }>("cron.runs", {
        id: job.id,
        limit: 10,
      });
      expect(history.entries).toEqual([
        expect.objectContaining({ runId: run.runId, status: "ok", completionStatus: "succeeded" }),
      ]);
      const interruptedError = "cron: job interrupted by gateway restart";
      const recovered = await restarted.request<CronJob>("cron.get", { id: unfinishedJob.id });
      expect(recovered).toMatchObject({
        enabled: false,
        state: {
          lastRunStatus: "error",
          lastStatus: "error",
          lastError: interruptedError,
          lastDelivered: false,
          lastDeliveryStatus: "unknown",
          lastFailureNotificationDeliveryStatus: "not-requested",
        },
      });
      expect(recovered.state.runningAtMs).toBeUndefined();
      expect(recovered.state.nextRunAtMs).toBeUndefined();
      expect(recovered.state.consecutiveErrors).toBe(activeJob.state.consecutiveErrors);
      const interruptedHistory = await restarted.request<{ entries: unknown[] }>("cron.runs", {
        id: unfinishedJob.id,
        limit: 10,
      });
      expect(interruptedHistory.entries).toEqual([
        expect.objectContaining({
          runId: unfinishedRun.runId,
          status: "error",
          completionStatus: "failed",
          error: interruptedError,
          delivered: false,
          deliveryStatus: "unknown",
        }),
      ]);
      const recoveredReceipts = await readUnfinishedReceipt();
      expect(recoveredReceipts).toEqual([
        { ...receipt, status: "interrupted", state_json: expect.any(String) },
      ]);
      const privateState = JSON.parse(recoveredReceipts[0]!.state_json);
      expect(privateState.runningReceiptId).toBeUndefined();
      expect(privateState.runningScheduleChangeId).toBeUndefined();
      expect(privateState.failureAlertIncident).toBeUndefined();
      await disconnectGatewayClient(restarted);
      await instance.stopGateway();
      await expect.poll(ownedBackends).toEqual([]);
      expect(await readPostgresAnchor(current)).toEqual(anchor);
      expect(requests.filter((body) => body.includes(prompt))).toHaveLength(1);
      expect(requests.filter((body) => body.includes(unfinishedPrompt))).toHaveLength(1);
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
      const interruptedRuns = await queryRows<{ status: string; detail_json: string }>(
        `SELECT status, detail_json FROM ${quoteIdentifier(anchor.namespace)}.task_runs WHERE runtime = 'cron' AND source_id = $1`,
        [unfinishedJob.id],
      );
      expect(interruptedRuns).toEqual([{ status: "failed", detail_json: expect.any(String) }]);
      expect(JSON.parse(interruptedRuns[0]!.detail_json)).toMatchObject({
        runId: unfinishedRun.runId,
        error: interruptedError,
      });
    },
  );
});
