import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { Value } from "typebox/value";
import { WebSocketServer } from "ws";
import type {
  SessionCatalog,
  SessionsCatalogListParams,
  SessionsCatalogListResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { SessionsCatalogHostEventSchema } from "../../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { observeSessionMaintenanceCompletion } from "../../config/sessions/session-accessor.sqlite-maintenance-completion.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { markPluginRegistryActive } from "../../plugins/registry-lifecycle.js";
import { createRuntimeTestRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import { createPluginServiceScheduler } from "../../plugins/service-scheduler.js";
import type { OpenClawPluginDefinition } from "../../plugins/types.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  loadBundledPluginFacade,
  resolveBundledPluginPublicModulePath,
} from "../../test-utils/bundled-plugin-public-surface.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import {
  createSessionRowProjection,
  type SessionRowProjection,
} from "../session-row-projection.js";
import type { createCatalogIoCounters } from "./session-catalog.performance-counters.test-support.js";
import type { GatewayClient } from "./types.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} };

export async function createComposedCatalogFixture(
  state: OpenClawTestState,
  counters: ReturnType<typeof createCatalogIoCounters>,
) {
  const agentDir = state.agentDir("main");
  await fs.mkdir(path.join(agentDir, "codex-home"), { recursive: true });
  const codexHome = await fs.realpath(path.join(agentDir, "codex-home"));
  const sessionsRoot = path.join(codexHome, "sessions", "2026", "09", "17");
  await fs.mkdir(sessionsRoot, { recursive: true });
  const publicEntry = resolveBundledPluginPublicModulePath({
    pluginId: "codex",
    artifactBasename: "index.js",
  });
  const rootDir = path.dirname(publicEntry);
  const packageJson = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8"));
  const nativeVersion = packageJson.dependencies["@openai/codex"];
  const rows = Array.from({ length: 3_000 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    projectId: null,
    name: `Project ${index % 12}: investigate retry behavior ${index}`,
    preview: `Review the session sidebar and preserve the original request deadline. ${"Synthetic context. ".repeat(40)}`,
    source: "cli",
    originator: "codex_cli_rs",
    cwd: state.workspaceDir,
    createdAt: 1_700_000_000 - index,
    updatedAt: 1_700_000_000 - index,
    recencyAt: 1_700_000_000 - index,
    path: path.join(sessionsRoot, `rollout-${index}.jsonl`),
    status: { type: "idle" },
    modelProvider: "openai",
    turns: [],
  }));
  for (let offset = 0; offset < rows.length; offset += 32) {
    await Promise.all(
      rows
        .slice(offset, offset + 32)
        .map((row) =>
          fs.writeFile(
            row.path,
            `${JSON.stringify({ timestamp: "2026-09-17T00:00:00.000Z", type: "session_meta", payload: { id: row.id, timestamp: "2026-09-17T00:00:00.000Z", cwd: row.cwd, source: row.source, originator: row.originator } })}\n`,
          ),
        ),
    );
  }
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const requests = new Map<string, number>();
  server.on("connection", (socket) =>
    socket.on("message", (encoded) => {
      const request = JSON.parse(rawDataToString(encoded)) as {
        id?: number;
        method: string;
        params?: { cursor?: string; limit?: number; threadId?: string };
      };
      if (request.id === undefined) {
        return;
      }
      requests.set(request.method, (requests.get(request.method) ?? 0) + 1);
      counters.nativeRequest(request.method);
      let result: unknown;
      if (request.method === "initialize") {
        result = { userAgent: `codex-cli/${nativeVersion}`, codexHome };
      } else if (request.method === "thread/list") {
        const offset = Number(request.params?.cursor ?? 0);
        const data = rows.slice(offset, offset + (request.params?.limit ?? 64));
        result = {
          data,
          nextCursor: offset + data.length < rows.length ? String(offset + data.length) : null,
        };
      } else if (request.method === "thread/read") {
        const thread = rows.find((row) => row.id === request.params?.threadId);
        if (!thread) {
          throw new Error("Unknown synthetic native thread");
        }
        result = { thread };
      } else if (request.method === "thread/turns/list" || request.method === "model/list") {
        result = { data: [], nextCursor: null };
      } else if (request.method === "account/read") {
        result = { account: { type: "apiKey" }, requiresOpenaiAuth: true };
      } else if (request.method === "config/read") {
        result = { config: {}, origins: {}, layers: [] };
      } else {
        socket.send(
          JSON.stringify({
            id: request.id,
            error: { code: -32601, message: `Unexpected synthetic request ${request.method}` },
          }),
        );
        return;
      }
      socket.send(JSON.stringify({ id: request.id, result }));
    }),
  );
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a bound loopback native endpoint");
  }
  const previous = captureActivePluginRegistrySnapshot();
  const scheduler = createTestGatewayScheduler();
  const serviceScheduler = createPluginServiceScheduler(scheduler).scheduler;
  let stopCatalog: (() => Promise<void>) | undefined;
  let projection: SessionRowProjection | undefined;
  let stateOwner: ReturnType<typeof acquireGatewayStateOwner> | undefined;
  const closeEndpoint = async () => {
    for (const socket of server.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  };
  const cleanup = async () => {
    projection?.dispose();
    serviceScheduler.beginClose();
    try {
      await stopCatalog?.();
    } finally {
      try {
        try {
          await scheduler.stop();
        } finally {
          await closeEndpoint();
        }
      } finally {
        try {
          if (stateOwner) {
            await closeStateDatabaseForTest();
          }
        } finally {
          stateOwner?.release();
          restoreActivePluginRegistrySnapshot(previous);
        }
      }
    }
  };
  try {
    const pluginConfig = {
      appServer: {
        transport: "websocket",
        url: `ws://127.0.0.1:${address.port}`,
      },
      computerUse: { enabled: false },
    };
    const config: OpenClawConfig = {
      agents: { entries: { main: { agentDir, workspace: state.workspaceDir } } },
      plugins: {
        slots: { memory: "none" },
        entries: { codex: { enabled: true, config: pluginConfig } },
      },
    };
    await state.writeConfig(config);
    setRuntimeConfigSnapshot(config);
    // Exercise the serving Gateway's admission path, including worker reads.
    stateOwner = acquireGatewayStateOwner({
      databasePath: resolveOpenClawStateSqlitePath(),
      payload: {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        configPath: state.configPath,
        stateDir: state.stateDir,
        role: "gateway",
      },
    });
    counters.observeOwnershipFile(stateOwner.path);
    // These are resident catalog rows, not an age-pruning fixture.
    const localUpdatedAt = Date.now();
    const databasePath = runOpenClawAgentWriteTransaction(
      (database) => {
        for (let index = 0; index < 3_000; index++) {
          writeSessionEntry(database, `agent:main:local-${index}`, {
            sessionId: `local-${index}`,
            updatedAt: localUpdatedAt - index,
            displayName: `Local session ${index}`,
          });
        }
        return database.path;
      },
      { agentId: "main" },
    );
    const runtime = createPluginRuntime();
    const builder = createRuntimeTestRegistry(runtime);
    const record = createPluginRecord({
      id: "codex",
      name: "Codex",
      rootDir,
      source: path.join(rootDir, "index.ts"),
      origin: "bundled",
      enabled: true,
      configSchema: true,
    });
    const api = builder.createApi(record, { config, pluginConfig });
    const { default: codexPlugin } = await loadBundledPluginFacade<{
      default: OpenClawPluginDefinition;
    }>({ pluginId: "codex", artifactBasename: "index.js" });
    if (!codexPlugin.register) {
      throw new Error("Codex public entry has no registration function");
    }
    codexPlugin.register(api);
    markPluginRegistryActive(builder.registry);
    setActivePluginRegistry(builder.registry);
    const service = builder.registry.services.find(
      (entry) => entry.service.id === "codex-session-catalog",
    )?.service;
    if (!service) {
      throw new Error("Codex did not register its catalog lifecycle");
    }
    const serviceContext = {
      config,
      stateDir: state.stateDir,
      workspaceDir: state.workspaceDir,
      logger,
      scheduler: serviceScheduler,
    };
    stopCatalog = async () => {
      await service.stop?.(serviceContext);
      for (const entry of builder.registry.agentHarnesses) {
        await entry.harness.dispose?.();
      }
    };
    await service.start(serviceContext);
    const connection = new AbortController();
    let sequence = 0;
    const setupPublications = new Map<string, (catalog: SessionCatalog) => void>();
    const client = {
      connectionSignal: connection.signal,
      connId: "composed-catalog",
      connect: { role: "operator", scopes: ["operator.admin"] },
    } as GatewayClient;
    const context = createDirectChatContext({
      getRuntimeConfig: () => config,
      logGateway: createSubsystemLogger("catalog-benchmark"),
      broadcast: () => {},
      broadcastToConnIds: (event, payload) => {
        if (
          event === "sessions.catalog.host" &&
          Value.Check(SessionsCatalogHostEventSchema, payload)
        ) {
          setupPublications.get(payload.progressId)?.(payload.catalog);
        }
      },
      nodeSendToSession: () => {},
      registerToolEventRecipient: () => {},
    });
    projection = await createSessionRowProjection({
      cfg: config,
      getConfig: () => config,
      modelCatalog: [],
      context,
    });
    bindSessionRowProjection(context, () => projection);
    async function call(
      method: "sessions.catalog.list" | "sessions.catalog.continue",
      params: Record<string, unknown>,
    ): Promise<unknown> {
      let result: unknown;
      let responded = false;
      await handleGatewayRequest({
        req: { type: "req", id: `composed-${++sequence}`, method, params },
        client,
        context,
        isWebchatConnect: () => false,
        signal: connection.signal,
        hasCurrentClientAuthority: () => !connection.signal.aborted,
        respond: (ok, payload, error) => {
          responded = true;
          if (!ok) {
            throw new Error(error?.message ?? "Catalog request failed");
          }
          result = payload;
        },
      });
      if (!responded) {
        throw new Error("Catalog request did not respond");
      }
      return result;
    }
    const requestList = async (params: Partial<SessionsCatalogListParams> = {}) =>
      (await call("sessions.catalog.list", {
        catalogId: "codex",
        agentId: "main",
        limitPerHost: 64,
        ...params,
        hostIds: ["gateway:local"],
      })) as SessionsCatalogListResult;
    const readHost = (catalog: SessionCatalog | undefined) => {
      if (!catalog || catalog.error) {
        throw new Error(catalog?.error?.message ?? "Missing Codex catalog");
      }
      if (catalog.hosts.length !== 1 || catalog.hosts[0]?.hostId !== "gateway:local") {
        throw new Error("Explicit local catalog request returned an unexpected host set");
      }
      const host = catalog.hosts[0];
      if (host.error) {
        throw new Error(host.error.message);
      }
      return host;
    };
    const list = async (params: Partial<SessionsCatalogListParams> = {}) =>
      readHost((await requestList(params)).catalogs.find((value) => value.id === "codex"));
    const setupList = async (params: Partial<SessionsCatalogListParams> = {}) => {
      const work = new AsyncWorkScope();
      const progressId = `catalog-setup-${++sequence}`;
      let published: SessionCatalog | undefined;
      setupPublications.set(progressId, (catalog) => {
        if (catalog.id === "codex" && catalog.hosts.every((host) => !host.pending)) {
          published = catalog;
        }
      });
      try {
        const result = await work.track(() => requestList({ ...params, progressId }));
        // The persistence marker can precede this request's provider and host publication.
        return await work.runWhenIdle(() => {
          const catalog = result.catalogs.find((value) => value.id === "codex");
          return readHost(
            catalog?.error?.code === "catalog_pending" ? (published ?? catalog) : catalog,
          );
        });
      } finally {
        setupPublications.delete(progressId);
        await work.drain();
      }
    };
    const setupMaintenance = { completed: 0 };
    let maintenanceReady: ReturnType<typeof observeSessionMaintenanceCompletion> | undefined;
    return {
      api,
      projection,
      rows,
      requests,
      requestList,
      list,
      setupList,
      setupMaintenance,
      async continueSession(hostId: string, threadId: string, sourceHomeId?: string) {
        // Fresh adoptions reuse the first acknowledged maintenance deadline; subsequent
        // no-op writes need not schedule another pass for the fixture to observe.
        const completed = (maintenanceReady ??= observeSessionMaintenanceCompletion(databasePath, {
          automatic: true,
        })).then(() => {
          setupMaintenance.completed++;
        });
        const [result] = await Promise.all([
          call("sessions.catalog.continue", {
            catalogId: "codex",
            agentId: "main",
            hostId,
            threadId,
            sourceHomeId,
          }),
          completed,
        ]);
        await nextTurn();
        return result;
      },
      async close() {
        connection.abort();
        await cleanup();
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
