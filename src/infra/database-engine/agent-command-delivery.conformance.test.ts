import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { getEnvironmentData } from "node:worker_threads";
import pg from "pg";
import { expect, it } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
  readRequestText,
} from "../../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { cliRecoveryEntrypoints } from "../../cli/cli-entrypoint.test-support.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { writeSinkPlugin } from "../../gateway/gateway.sessions-send-provenance.transport.test-support.js";
import { connectGatewayClient, disconnectGatewayClient } from "../../gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../../gateway/test-openai-responses-model.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import type { QueuedDelivery } from "../outbound/delivery-queue-types.js";
import { dropPostgresTestSchemas } from "../postgres-sync/schema-cleanup.test-support.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../runtime-worker-url.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const DSN_ENV = "OPENCLAW_RPC_WRITER_HANDOFF_DSN";

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

it("keeps RPC final-delivery custody after the runner claims an existing session", async ({
  signal,
}) => {
  await using resources = new AsyncDisposableStack();
  const prefix = `rpc_handoff_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const client = connection ? new pg.Client({ connectionString: connection }) : undefined;
  if (client) {
    await client.connect();
    resources.defer(() => client.end());
    resources.defer(() => dropPostgresTestSchemas(client, prefix));
  }

  // Read through a separate native connection, without the Gateway's session cache
  // or shim. The anchor selects the same physical store for PostgreSQL proof.
  async function readJsonRows<T>(
    filename: string,
    table: "session_nodes" | "delivery_queue_entries",
    column: "session_key" | "target",
    value: string,
  ): Promise<T[]> {
    using db = openNodeSqliteDatabase(filename, { readOnly: true });
    const rows = client
      ? await (async () => {
          const anchor = db.prepare("SELECT schema FROM openclaw_engine_anchor").get();
          if (typeof anchor?.schema !== "string") {
            throw new Error("Gateway did not persist its PostgreSQL anchor");
          }
          return (
            await client.query<{ entry_json: string }>(
              `SELECT entry_json FROM ${quoteIdentifier(anchor.schema)}.${table} WHERE ${column} = $1`,
              [value],
            )
          ).rows;
        })()
      : db.prepare(`SELECT entry_json FROM ${table} WHERE ${column} = ?`).all(value);
    return rows.map((row) => {
      if (typeof row.entry_json !== "string") {
        throw new Error(`Missing ${table} entry JSON`);
      }
      return JSON.parse(row.entry_json) as T;
    });
  }

  const entered = createDeferred();
  const release = createDeferred();
  const sends: unknown[] = [];
  const reply = "RPC_WRITER_HANDOFF_COMPLETE";
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readRequestText(request);
      if (request.url === "/v1/responses") {
        writeOpenAiResponsesText(response, {
          text: reply,
          responseId: "rpc-writer-response",
          messageId: "rpc-writer-message",
        });
        return;
      }
      if (request.url === "/sink") {
        sends.push(JSON.parse(body));
        entered.resolve();
        await release.promise;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ channel: "telegram", messageId: "sink-receipt" }));
        return;
      }
      response.writeHead(404).end();
    })().catch((error: unknown) => response.writeHead(500).end(String(error)));
  });
  const url = await listenLoopback(server);
  resources.defer(() => closeHttpServer(server));
  const nodeExecutable = resolveTestNodeExecPath();
  const instance = await createOpenClawTestInstance({
    name: "rpc-writer-handoff",
    signal,
    entrypoint: resolveRuntimeWorkerArgv(
      resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli),
      nodeExecutable,
    ),
    gatewayCommandPrefix: [nodeExecutable],
    env: {
      [DSN_ENV]: connection,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_GATEWAY_RESTART_TRACE: "0",
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_NO_RESPAWN: "1",
      NODE_DISABLE_COMPILE_CACHE: "1",
    },
    config: {
      ...(connection
        ? {
            database: {
              engine: "postgres",
              postgres: {
                connection: { source: "env", provider: "default", id: DSN_ENV },
                schemaPrefix: prefix,
              },
            },
          }
        : {}),
      gateway: { mode: "local" },
      skills: { load: { watch: false } },
    },
  });
  resources.defer(() => instance.cleanup());
  const provider = buildMockOpenAiResponsesProvider(`${url}/v1`);
  const config: OpenClawConfig = {
    ...JSON.parse(await fs.readFile(instance.state.configPath, "utf8")),
    agents: {
      defaults: {
        workspace: instance.state.workspaceDir,
        skipBootstrap: true,
        model: { primary: provider.modelRef },
        models: {
          [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
        },
      },
      entries: { main: {} },
    },
    models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
    plugins: {
      allow: ["provenance-sink"],
      entries: { "provenance-sink": { enabled: true } },
      load: { paths: [await writeSinkPlugin(instance.state.workspaceDir, `${url}/sink`)] },
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
  await instance.state.writeConfig(config);
  delete instance.env.VITEST;
  delete instance.env.NODE_ENV;
  await instance.startGateway();
  const gateway = await connectGatewayClient({
    url: instance.url,
    token: instance.gatewayToken,
    clientDisplayName: "vitest-rpc-writer-handoff",
    signal,
  });
  resources.defer(() => disconnectGatewayClient(gateway));
  // Always unblock transport before joining the Gateway, including assertion failures.
  resources.defer(() => release.resolve());
  const key = "agent:main:rpc-writer-handoff";
  const target = "provenance-rpc-writer-handoff";
  const agentPath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: instance.state.env });
  const readSession = () =>
    readJsonRows<InternalSessionEntry>(agentPath, "session_nodes", "session_key", key);
  await gateway.request("sessions.create", { agentId: "main", key });
  const [before] = await readSession();
  expect(before).toBeDefined();
  const run = await gateway.request<{ runId: string }>("agent", {
    sessionKey: key,
    message: "Reply with the final handoff confirmation.",
    deliver: true,
    channel: "telegram",
    to: target,
    idempotencyKey: randomUUID(),
  });
  const completion = gateway.request(
    "agent.wait",
    { runId: run.runId, timeoutMs: 60_000 },
    { timeoutMs: 65_000 },
  );
  await withinTest(
    awaitGateBeforeSettlement(
      entered.promise,
      completion,
      "RPC finished without reaching final transport",
    ),
    signal,
  );
  const [claimed] = await readSession();
  expect(claimed).toMatchObject({ sessionId: before?.sessionId, activeWriterRunId: run.runId });
  expect(claimed?.activeWriterRunId).not.toBe(before?.activeWriterRunId);
  expect(claimed?.pendingFinalDelivery).toMatchObject({
    kind: "transport-only",
    deliveries: [{ state: "queued" }],
    context: { channel: "telegram", to: target },
  });
  const queued = await readJsonRows<QueuedDelivery>(
    resolveOpenClawStateSqlitePath(instance.state.env),
    "delivery_queue_entries",
    "target",
    target,
  );
  expect(queued).toHaveLength(1);
  expect(queued[0]?.deliveryCompletion).toMatchObject({
    kind: "pending-final",
    sessionKey: key,
    sessionId: claimed?.sessionId,
    intentId: claimed?.pendingFinalDelivery?.intentId,
    deliveryId: claimed?.pendingFinalDelivery?.deliveries?.[0]?.id,
  });
  release.resolve();
  await expect(withinTest(completion, signal)).resolves.toMatchObject({ status: "ok" });
  expect(sends).toEqual([{ to: target, text: reply, accountId: "default" }]);
  expect((await readSession())[0]?.pendingFinalDelivery).toBeUndefined();
  expect(
    await readJsonRows(
      resolveOpenClawStateSqlitePath(instance.state.env),
      "delivery_queue_entries",
      "target",
      target,
    ),
  ).toEqual([]);
});
