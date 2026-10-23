import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { readRequestText } from "../../../test/helpers/gateway-integration-fixtures.js";
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
  expectAssistantReply,
} from "../../gateway/server-methods/models-catalog-fixture.test-support.js";
import {
  closeModelsEndpoint,
  createModelsTestState,
  listenModelsEndpoint,
  startModelsGateway,
} from "../../gateway/server-methods/models-integration.test-support.js";
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
import { retireSqliteDatabaseAdmissionForPath } from "../sqlite-database-admission.js";
import { sqliteWorkerPreloadEnv } from "../sqlite-worker-preload.test-support.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const localProvider = "inheritauth-local";
const inheritedProvider = "inheritauth-owner";
const localProfile = `${localProvider}:local`;
const inheritedProfile = `${inheritedProvider}:inherited`;
const localKey = "synthetic-inheritauth-local-key";
const inheritedKey = "synthetic-inheritauth-owner-key";

function currentMainSnapshot() {
  const input = listConfiguredOwnerInputs(getRuntimeConfig(), undefined, true).find(
    (entry) => entry.agentId === "main",
  );
  return input && getPreparedModelRuntimeSnapshot(input);
}

async function closeDatabases() {
  withEngineStoreAdmission(() => closeOpenClawAgentDatabasesForTest());
  await closeOpenClawAgentDatabasesAsync();
  await closeStateDatabaseForTest();
}

describe.skipIf(!connection)("PostgreSQL inherited auth startup", () => {
  it("publishes admitted agents without a pending owner's credentials and adds them on admission", async ({
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
    let unsubscribe: (() => void) | undefined;
    const requests: Array<{ authorization: string | undefined; body: string }> = [];
    const providerErrors: unknown[] = [];
    const providerWork: Promise<void>[] = [];
    const endpoint = createServer((request, response) => {
      const work = (async () => {
        if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
          response.writeHead(404).end();
          return;
        }
        requests.push({
          authorization: request.headers.authorization,
          body: await readRequestText(request),
        });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(catalogReply("inherited-auth", "fixture", "INHERITOR_OK"));
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
        id: "fixture",
        name: "Inherited auth fixture",
        reasoning: false,
        input: ["text" as const],
        contextWindow: 32_768,
        maxTokens: 1_024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
          entries: { main: {}, owner: {} },
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
      withEngineStoreAdmission(() => {
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
        expect(readAgentDatabaseAdmissionRefusal("owner", { env: state.env })).toMatchObject({
          code: "agent-database-inspection-pending",
        });
        const pendingReadiness = await fetch(`http://127.0.0.1:${gateway.port}/readyz`);
        expect(pendingReadiness.status).toBe(503);
        expect(await pendingReadiness.json()).toMatchObject({
          ready: false,
          coreReady: false,
          failing: expect.arrayContaining(["chat-recovery"]),
        });
        const initial = currentMainSnapshot();
        expect(initial).toBeDefined();
        expect(initial!.inheritedAuthDir).toBe(state.agentDir("owner"));
        expect(getPreparedModelRuntimeAuthStore(initial!)?.profiles).toEqual({
          [localProfile]: { type: "api_key", provider: localProvider, key: localKey },
        });
        const rpc = catalogSessionRpc(gateway.client);
        const session = await rpc.create(`${localProvider}/fixture`, "agent:main:pending-owner");
        // The agent RPC is available while saved-input recovery still gates fresh chat.
        const started = await gateway.client.request<{ runId: string; status: string }>("agent", {
          agentId: "main",
          sessionKey: session.key,
          message: "Reply with INHERITOR_OK.",
          deliver: false,
          idempotencyKey: "pending-owner",
        });
        expect(started.status).toBe("accepted");
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
          const snapshot = currentMainSnapshot();
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
        await expect
          .poll(async () => (await fetch(`http://127.0.0.1:${gateway!.port}/readyz`)).status, {
            timeout: 20_000,
          })
          .toBe(200);
        const recovered = currentMainSnapshot();
        expect(getPreparedModelRuntimeAuthStore(recovered!)?.profiles[inheritedProfile]).toEqual({
          type: "api_key",
          provider: inheritedProvider,
          key: inheritedKey,
        });
        const recoveredStores = recovered!.createStores();
        const inheritedModel = recoveredStores.modelRegistry.find(inheritedProvider, "fixture");
        expect(inheritedModel).toBeDefined();
        await expect(
          recoveredStores.modelRegistry.getApiKeyAndHeaders(inheritedModel!),
        ).resolves.toMatchObject({ apiKey: inheritedKey });
      });
    } finally {
      unsubscribe?.();
      signal.removeEventListener("abort", releaseInspection);
      releaseInspection();
      await gateway?.close();
      endpoint.closeAllConnections();
      if (endpoint.listening) {
        await closeModelsEndpoint(endpoint);
      }
      await Promise.allSettled(providerWork);
      await closeDatabases();
      const schemas = await database.query<{ nspname: string }>(
        "SELECT nspname FROM pg_namespace WHERE starts_with(nspname, $1)",
        [prefix + "_"],
      );
      for (const { nspname } of schemas.rows) {
        await database.query(`DROP SCHEMA "${nspname.replaceAll('"', '""')}" CASCADE`);
      }
      await database.end();
      await state.cleanup();
      clearSecretsRuntimeSnapshot();
      await resetPreparedModelCatalogStateForTest();
      resetDatabaseEngineSelectionForTest();
      resetConfigRuntimeState();
    }
  }, 90_000);
});
