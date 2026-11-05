import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import { getEnvironmentData } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { Client } from "pg";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { rawDataToString } from "../../../packages/gateway-client/src/websocket-data.js";
import { WebSocket } from "../../../packages/gateway-client/src/websocket.js";
import type { ResponseFrame } from "../../../packages/gateway-protocol/src/schema/frames.js";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.js";
import { readRequestText } from "../../../test/helpers/gateway-integration-fixtures.js";
import {
  acquireGatewayTestWebSocket,
  closeGatewayTestWebSocket,
} from "../../../test/helpers/gateway-websocket.js";
import { withinTest } from "../../../test/helpers/promise.js";
import { resolveSharedAuthStoreOwnership } from "../../agents/auth-profiles/path-resolve.js";
import { resolveAuthProfileDatabasePath } from "../../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../../agents/auth-profiles/store-runtime.js";
import { getPreparedModelRuntimeAuthStore } from "../../agents/prepared-model-runtime-auth.js";
import { listConfiguredOwnerInputs } from "../../agents/prepared-model-runtime.configured.js";
import {
  getPreparedModelRuntimeSnapshot,
  registerPreparedModelRuntimePublicationListener,
} from "../../agents/prepared-model-runtime.js";
import { resetPreparedModelCatalogStateForTest } from "../../agents/prepared-model-runtime.test-support.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/io.js";
import { resetConfigRuntimeState } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { installGatewayDatabaseEngine } from "../../gateway/server-database-engine.js";
import {
  catalogReply,
  catalogSessionRpc,
  createCatalogModel,
  expectAssistantReply,
} from "../../gateway/server-methods/models-catalog-fixture.test-support.js";
import {
  closeModelsEndpoint,
  createModelsTestState,
  listenModelsEndpoint,
  startModelsGateway,
} from "../../gateway/server-methods/models-integration.test-support.js";
import { loadOrCreateDeviceIdentityAsync } from "../../infra/device-identity-async.js";
import { clearSecretsRuntimeSnapshot } from "../../secrets/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { readAgentDatabaseAdmissionRefusal } from "../../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../../state/agent-database-startup.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { assertOpenClawDatabasesReady } from "../../state/openclaw-database-preflight.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { acquireStateDatabaseSchemaLease } from "../gateway-state-owner.js";
import { dropPostgresTestSchemas } from "../postgres-sync/schema-cleanup.test-support.js";
import { retireSqliteDatabaseAdmissionForPath } from "../sqlite-database-admission.js";
import { sqliteWorkerPreloadEnv } from "../sqlite-worker-preload.test-support.js";
import { withEngineStoreAdmission as admit } from "./admission-scope.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const localProvider = "inheritauth-local";
const inheritedProvider = "inheritauth-owner";
const localProfile = `${localProvider}:local`;
const inheritedProfile = `${inheritedProvider}:inherited`;
const localKey = "synthetic-inheritauth-local-key";
const inheritedKey = "synthetic-inheritauth-owner-key";
const ownerMarkers = (messages: Array<{ role: string; content: unknown }>) =>
  messages.flatMap((message) =>
    message.role === "user"
      ? ["FRESH_OWNER"].filter((marker) => JSON.stringify(message.content ?? null).includes(marker))
      : [],
  );

function currentAgentSnapshot(agentId = "main") {
  const input = listConfiguredOwnerInputs(getRuntimeConfig(), undefined, true).find(
    (entry) => entry.agentId === agentId,
  );
  return input && getPreparedModelRuntimeSnapshot(input);
}

async function closeDatabases() {
  admit(() => closeOpenClawAgentDatabasesForTest());
  await closeOpenClawAgentDatabasesAsync();
  await closeStateDatabaseForTest();
}

describe.skipIf(!connection)("PostgreSQL inherited auth startup", () => {
  // One real PostgreSQL startup and three model turns prove inherited auth admission.
  it("serves admitted agents before and after the inherited auth owner becomes ready", async ({
    signal,
  }) => {
    const prefix = `inheritauth_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const database = new Client({ connectionString: connection });
    await database.connect();
    const state = await createModelsTestState("postgres-inherited-auth", {
      env: {
        OPENCLAW_TEST_INHERITED_AUTH_DSN: connection,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_SKIP_PROVIDERS: "1",
      },
    });
    const inspectionEntered = state.path("owner-inspection-entered");
    const inspectionRelease = state.path("owner-inspection-release");
    const preload = state.path("pause-owner-inspection.cjs");
    const releaseInspection = () => fs.writeFileSync(inspectionRelease, "resume");
    signal.addEventListener("abort", releaseInspection, { once: true });
    onTestFinished(() => {
      signal.removeEventListener("abort", releaseInspection);
      vi.unstubAllEnvs();
    });
    // Delay delivery, not inspection results: the child reads PostgreSQL after release.
    fs.writeFileSync(
      preload,
      `const fs = require('node:fs');
const emit = process.emit;
process.emit = function(event, ...args) {
  const request = args[0];
  if (event === 'message' && request?.type === 'inspect' &&
      request.input?.agentId === 'owner' &&
      request.input.requireStartupMigrationReadiness === true &&
      request.databaseEngineSelection) {
    fs.writeFileSync(${JSON.stringify(inspectionEntered)}, 'entered');
    const pause = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(${JSON.stringify(inspectionRelease)})) {
      Atomics.wait(pause, 0, 0, 10);
    }
  }
  return emit.call(this, event, ...args);
};
`,
    );
    for (const [key, value] of Object.entries(sqliteWorkerPreloadEnv(preload))) {
      vi.stubEnv(key, value);
    }
    let gateway: Awaited<ReturnType<typeof startModelsGateway>> | undefined;
    let probe: WebSocket | undefined;
    let unsubscribe: (() => void) | undefined;
    const ownerSessionKey = "agent:owner:admitted-owner";
    const requests: Array<{ authorization: string | undefined; body: string }> = [];
    const ownerInputOrder: string[] = [];
    const ownerAuthorizations: Array<string | undefined> = [];
    const providerErrors: unknown[] = [];
    const providerWork: Promise<void>[] = [];
    const endpoint = createServer((request, response) => {
      const work = (async () => {
        if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
          response.writeHead(404).end();
          return;
        }
        const body = await readRequestText(request);
        requests.push({
          authorization: request.headers.authorization,
          body,
        });
        const messages = (
          JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> }
        ).messages;
        // Runtime context may follow the actual user input.
        const ownerInput = ownerMarkers(messages).at(-1);
        if (ownerInput) {
          ownerInputOrder.push(ownerInput);
          ownerAuthorizations.push(request.headers.authorization);
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(catalogReply("inherited-auth", "fixture", `${ownerInput ?? "INHERITOR"}_OK`));
      })();
      providerWork.push(work);
      void work.catch((error: unknown) => {
        providerErrors.push(error);
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    try {
      const baseUrl = `${await listenModelsEndpoint(endpoint)}/v1`;
      const model = {
        ...createCatalogModel("fixture", "Inherited auth fixture"),
        maxTokens: 1_024,
      };
      const cfg: OpenClawConfig = {
        database: {
          engine: "postgres",
          postgres: {
            connection: {
              source: "env",
              provider: "default",
              id: "OPENCLAW_TEST_INHERITED_AUTH_DSN",
            },
            schemaPrefix: prefix,
          },
        },
        agents: {
          ownership: "explicit",
          defaults: {
            authInheritance: { agentId: "owner" },
            systemAgent: { agentId: "main" },
            model: { primary: `${localProvider}/fixture` },
            utilityModel: "",
            skipBootstrap: true,
            workspace: state.workspaceDir,
          },
          entries: {
            main: {},
            owner: { model: { primary: `${inheritedProvider}/fixture` } },
            inheritor: { model: { primary: `${inheritedProvider}/fixture` } },
          },
        },
        models: {
          mode: "replace",
          catalogRefresh: { enabled: false },
          providers: Object.fromEntries(
            [localProvider, inheritedProvider].map((provider) => [
              provider,
              {
                baseUrl,
                api: "openai-completions" as const,
                agentRuntime: { id: "openclaw" },
                request: { allowPrivateNetwork: true },
                models: [model],
              },
            ]),
          ),
        },
        gateway: { mode: "local", auth: { mode: "token", token: "inheritauth-token" } },
        tools: { profile: "minimal" },
        plugins: { enabled: false },
        skills: { load: { watch: false } },
        meta: { migrations: { webhookListeners: true } },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      await installGatewayDatabaseEngine();
      admit(() => {
        const lease = acquireStateDatabaseSchemaLease(resolveOpenClawStateSqlitePath(state.env));
        try {
          lease.run(() => {
            for (const [agentId, profileId, provider, key] of [
              ["main", localProfile, localProvider, localKey],
              ["owner", inheritedProfile, inheritedProvider, inheritedKey],
            ] as const) {
              saveAuthProfileStore(
                { version: 1, profiles: { [profileId]: { type: "api_key", provider, key } } },
                state.agentDir(agentId),
                { filterExternalAuthProfiles: false, syncExternalCli: false },
              );
            }
          });
        } finally {
          lease.release();
        }
      });
      await loadOrCreateDeviceIdentityAsync();
      expect(resolveSharedAuthStoreOwnership(state.env)).toEqual({ location: "legacy-main" });
      const mainPath = resolveAuthProfileDatabasePath(state.agentDir());
      const ownerPath = resolveAuthProfileDatabasePath(state.agentDir("owner"));
      await closeDatabases();
      for (const pathname of [mainPath, ownerPath]) {
        retireSqliteDatabaseAdmissionForPath(pathname);
      }
      clearSecretsRuntimeSnapshot();
      await resetPreparedModelCatalogStateForTest();

      await withAgentDatabaseStartupAdmission(async (admission) => {
        await assertOpenClawDatabasesReady({
          env: state.env,
          operation: "gateway-startup",
          config: cfg,
        });
        await expect.poll(() => fs.existsSync(inspectionEntered), { timeout: 30_000 }).toBe(true);
        gateway = await startModelsGateway(state, cfg, "inheritauth-token");
        await gateway.server.startupSettled;
        await admission.waitForAgentPreparation("main", { env: state.env, signal });
        const rpc = catalogSessionRpc(gateway.client);
        // An admitted agent serves ordinary session creation while its auth owner is pending.
        const session = await rpc.create(`${localProvider}/fixture`, "agent:main:pending-owner");
        const pendingOwner = expectDefined(
          readAgentDatabaseAdmissionRefusal("owner", { env: state.env }),
          "pending owner admission",
        );
        expect(pendingOwner).toMatchObject({
          code: "agent-database-inspection-pending",
        });
        probe = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
        const responses = new Map<string, ReturnType<typeof createDeferredCore<ResponseFrame>>>();
        probe.on("message", (data) => {
          const frame = JSON.parse(rawDataToString(data)) as ResponseFrame;
          if (frame.type === "res") {
            responses.get(frame.id)?.resolve(frame);
          }
        });
        await acquireGatewayTestWebSocket(probe, 5_000);
        const socket = probe;
        const requestProbe = (id: string, method: string, params: unknown) => {
          const response = createDeferredCore<ResponseFrame>();
          responses.set(id, response);
          socket.send(JSON.stringify({ type: "req", id, method, params }));
          return withinTest(response.promise, signal);
        };
        expect(
          await requestProbe("connect", "connect", {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: { id: "gateway-client", version: "test", platform: "test", mode: "backend" },
            role: "operator",
            scopes: ["operator.admin"],
            auth: { token: "inheritauth-token" },
          }),
        ).toMatchObject({ ok: true });
        const ownerFreshInput = {
          agentId: "owner",
          sessionKey: ownerSessionKey,
          message: "FRESH_OWNER",
          idempotencyKey: "fresh-owner",
          queueMode: "followup",
          deliver: false,
        };
        // Read the raw refusal: GatewayClient retries startup errors automatically.
        expect(await requestProbe("owner-pending", "chat.send", ownerFreshInput)).toMatchObject({
          ok: false,
          error: {
            code: "UNAVAILABLE",
            retryable: true,
            message: `${pendingOwner.reason}\n${pendingOwner.repairHint}`,
          },
        });
        await expect
          .poll(async () => (await fetch(`http://127.0.0.1:${gateway!.port}/readyz`)).status, {
            timeout: 20_000,
          })
          .toBe(200);
        const initial = currentAgentSnapshot();
        expect(initial).toBeDefined();
        const initialInheritor = currentAgentSnapshot("inheritor");
        expect(initialInheritor).toBeDefined();
        expect(
          getPreparedModelRuntimeAuthStore(initialInheritor!)?.profiles[inheritedProfile],
        ).toBeUndefined();
        expect(
          getPreparedModelRuntimeAuthStore(initial!)?.profiles[inheritedProfile],
        ).toBeUndefined();
        const started = await rpc.send(session.key, "Reply with INHERITOR_OK.", "pending-owner");
        expect(await rpc.wait(started.runId)).toMatchObject({ status: "ok" });
        expectAssistantReply((await rpc.history(session.key)).messages, "INHERITOR_OK");
        expect(requests).toContainEqual({
          authorization: `Bearer ${localKey}`,
          body: expect.stringContaining("Reply with INHERITOR_OK."),
        });
        expect(providerErrors).toEqual([]);
        expect(readAgentDatabaseAdmissionRefusal("owner", { env: state.env })).toMatchObject({
          code: "agent-database-inspection-pending",
        });

        const inheritedPublished = createDeferredCore();
        unsubscribe = registerPreparedModelRuntimePublicationListener((event) => {
          const snapshot = currentAgentSnapshot();
          if (
            event.phase === "published" &&
            snapshot &&
            getPreparedModelRuntimeAuthStore(snapshot)?.profiles[inheritedProfile]
          ) {
            inheritedPublished.resolve();
          }
        });
        releaseInspection();
        await withinTest(inheritedPublished.promise, signal);
        await admission.waitForAgentPreparation("owner", { env: state.env, signal });
        expect(readAgentDatabaseAdmissionRefusal("owner", { env: state.env })).toBeUndefined();
        const recovered = currentAgentSnapshot();
        expect(getPreparedModelRuntimeAuthStore(recovered!)?.profiles[inheritedProfile]).toEqual({
          type: "api_key",
          provider: inheritedProvider,
          key: inheritedKey,
        });
        await gateway.client.request("sessions.create", {
          agentId: "owner",
          model: `${inheritedProvider}/fixture`,
          key: ownerSessionKey,
        });
        const fresh = await gateway.client.request<{ runId: string }>("chat.send", ownerFreshInput);
        expect(await rpc.wait(fresh.runId)).toMatchObject({ status: "ok" });
        expect(ownerInputOrder).toEqual(["FRESH_OWNER"]);
        expect(ownerAuthorizations).toEqual([`Bearer ${inheritedKey}`]);
        const history = await rpc.history(ownerSessionKey);
        expect(ownerMarkers(history.messages as Array<{ role: string; content: unknown }>)).toEqual(
          ["FRESH_OWNER"],
        );
        const inheritor = await gateway.client.request<{ key: string }>("sessions.create", {
          agentId: "inheritor",
          model: `${inheritedProvider}/fixture`,
          key: "agent:inheritor:admitted-owner",
        });
        const inheritedInput = "Reply with INHERITOR_OK after the owner is admitted.";
        const inherited = await rpc.send(inheritor.key, inheritedInput, "admitted-owner");
        expect(await rpc.wait(inherited.runId)).toMatchObject({ status: "ok" });
        expect(
          requests.find((request) => request.body.includes(inheritedInput))?.authorization,
        ).toBe(`Bearer ${inheritedKey}`);
        expectAssistantReply((await rpc.history(inheritor.key)).messages, "INHERITOR_OK");
        expect(providerErrors).toEqual([]);
      });
    } finally {
      unsubscribe?.();
      signal.removeEventListener("abort", releaseInspection);
      releaseInspection();
      if (probe) {
        await closeGatewayTestWebSocket(probe);
      }
      await gateway?.close();
      endpoint.closeAllConnections();
      if (endpoint.listening) {
        await closeModelsEndpoint(endpoint);
      }
      await Promise.allSettled(providerWork);
      await closeDatabases();
      await dropPostgresTestSchemas(database, prefix);
      await database.end();
      await state.cleanup();
      clearSecretsRuntimeSnapshot();
      await resetPreparedModelCatalogStateForTest();
      resetDatabaseEngineSelectionForTest();
      resetConfigRuntimeState();
      vi.restoreAllMocks();
    }
  }, 270_000);
});
