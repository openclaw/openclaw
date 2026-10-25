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
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { stageSessionPendingInput } from "../../config/sessions/session-accessor.pending-inputs.js";
import * as recoveryEntries from "../../config/sessions/session-entry-read-maintenance.js";
import { listSessionPendingInputs } from "../../config/sessions/session-pending-input-history.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createOperatorRecoveryFixture } from "../../gateway/operator-run-recovery.test-support.js";
import { installGatewayDatabaseEngine } from "../../gateway/server-database-engine.js";
import {
  createChatInputRecovery,
  normalizeChatSendRequest,
} from "../../gateway/server-methods/chat-send-request.js";
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
import { createContext } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
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
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { acquireStateDatabaseSchemaLease } from "../gateway-state-owner.js";
import { dropPostgresTestSchemas } from "../postgres-sync/schema-cleanup.test-support.js";
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

function currentAgentSnapshot(agentId = "main") {
  const input = listConfiguredOwnerInputs(getRuntimeConfig(), undefined, true).find(
    (entry) => entry.agentId === agentId,
  );
  return input && getPreparedModelRuntimeSnapshot(input);
}

async function closeDatabases() {
  withEngineStoreAdmission(() => closeOpenClawAgentDatabasesForTest());
  await closeOpenClawAgentDatabasesAsync();
  await closeStateDatabaseForTest();
}

describe.skipIf(!connection)("PostgreSQL inherited auth startup", () => {
  // One real PostgreSQL startup, four model turns, and deferred saved-input recovery.
  it("serves admitted agents and replays a deferred owner's saved input before fresh input", async ({
    signal,
  }) => {
    const startedAt = performance.now();
    let phase = "fixture";
    let phaseStartedAt = startedAt;
    const reportPhase = (event: "start" | "complete" | "aborted") => {
      const now = performance.now();
      console.info(
        `[inherited-auth] ${event} phase=${phase} elapsedMs=${Math.round(now - phaseStartedAt)} totalMs=${Math.round(now - startedAt)}`,
      );
    };
    const enterPhase = (next: string) => {
      reportPhase("complete");
      phase = next;
      phaseStartedAt = performance.now();
    };
    const reportAbort = () => reportPhase("aborted");
    reportPhase("start");
    signal.addEventListener("abort", reportAbort, { once: true });
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
      signal.removeEventListener("abort", reportAbort);
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
    const recoveryEntered = createDeferredCore();
    const releaseRecovery = createDeferredCore();
    const savedInputStarted = createDeferredCore();
    const freshInputStarted = createDeferredCore();
    const releaseSavedInput = createDeferredCore();
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
        const ownerInput = messages
          .filter((message) => message.role === "user")
          .flatMap((message) =>
            ["SAVED_OWNER", "FRESH_OWNER"].filter((marker) =>
              JSON.stringify(message.content).includes(marker),
            ),
          )
          .at(-1);
        if (ownerInput) {
          ownerInputOrder.push(ownerInput);
          ownerAuthorizations.push(request.headers.authorization);
        }
        if (ownerInput === "SAVED_OWNER") {
          savedInputStarted.resolve();
          await withinTest(releaseSavedInput.promise, signal);
        } else if (ownerInput === "FRESH_OWNER") {
          freshInputStarted.resolve();
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
      const profile = withEngineStoreAdmission(() =>
        ensureProfileForEmail("inherited-auth-recovery@example.test"),
      );
      const fixture = await createOperatorRecoveryFixture({
        stateDir: state.stateDir,
        context: createContext(),
        profileId: profile.id,
        config: cfg,
        agentId: "owner",
        sessionKey: "agent:owner:recovery-order",
        sourceRunId: "saved-owner",
        parentSessionKey: null,
      });
      await loadOrCreateDeviceIdentityAsync();
      const normalized = await normalizeChatSendRequest({
        client: fixture.client,
        params: {
          agentId: "owner",
          sessionKey: fixture.target.sessionKey,
          idempotencyKey: fixture.target.sourceRunId,
          message: "SAVED_OWNER",
          queueMode: "followup",
          deliver: false,
        },
      });
      if (!normalized.ok) {
        throw new Error(normalized.error);
      }
      const requestFingerprint = expectDefined(
        normalized.value.requestIdentity,
        "saved owner input fingerprint",
      );
      const recovery = expectDefined(
        createChatInputRecovery({
          request: normalized.value,
          source: fixture.entry.restartRecoveryOperatorSource,
        }),
        "saved owner input authority",
      );
      // This is saved input, without a separate interrupted predecessor to resume.
      await replaceSessionEntry(fixture.target, {
        sessionId: fixture.entry.sessionId,
        updatedAt: Date.now(),
        lifecycleRevision: fixture.entry.lifecycleRevision,
        createdActor: fixture.entry.createdActor,
      });
      const receipt = expectDefined(
        await stageSessionPendingInput(fixture.target, {
          runId: fixture.target.sourceRunId,
          requestFingerprint,
          message: {
            role: "user",
            content: "SAVED_OWNER",
            timestamp: Date.now(),
            idempotencyKey: `${fixture.target.sourceRunId}:user`,
            __openclaw: {
              chatInputRecovery: recovery,
              chatRequestIdentity: requestFingerprint,
            },
          },
          assertCurrent() {},
        }),
        "durable saved owner input",
      );
      receipt.finish("interrupted");
      await receipt.settled?.();
      const owner = fixture.target;
      const readRecoveryEntries = recoveryEntries.readPendingInputRecoveryEntriesInWorker;
      vi.spyOn(recoveryEntries, "readPendingInputRecoveryEntriesInWorker").mockImplementation(
        async (input) => {
          if (input.agentId === "owner") {
            recoveryEntered.resolve();
            await withinTest(releaseRecovery.promise, signal);
          }
          return readRecoveryEntries(input);
        },
      );
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
        enterPhase("database-preparation");
        await assertOpenClawDatabasesReady({
          env: state.env,
          operation: "gateway-startup",
          config: cfg,
        });
        await expect.poll(() => fs.existsSync(inspectionEntered), { timeout: 30_000 }).toBe(true);
        enterPhase("gateway-startup");
        gateway = await startModelsGateway(state, cfg, "inheritauth-token");
        await gateway.server.startupSettled;
        await admission.waitForAgentPreparation("main", { env: state.env, signal });
        const rpc = catalogSessionRpc(gateway.client);
        enterPhase("healthy-agent");
        // Session creation waits for ordinary startup methods, independently of chat recovery.
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
          sessionKey: owner.sessionKey,
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
        expect(initial!.inheritedAuthDir).toBe(state.agentDir("owner"));
        expect(getPreparedModelRuntimeAuthStore(initial!)?.profiles).toEqual({
          [localProfile]: { type: "api_key", provider: localProvider, key: localKey },
        });
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

        enterPhase("owner-admission");
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
        await withinTest(recoveryEntered.promise, signal);
        expect(await requestProbe("owner-recovering", "chat.send", ownerFreshInput)).toMatchObject({
          ok: false,
          error: { code: "UNAVAILABLE", retryable: true },
        });
        expect(ownerInputOrder).toEqual([]);
        expect((await listSessionPendingInputs(owner)).items).toMatchObject([
          { runId: owner.sourceRunId, state: "interrupted" },
        ]);
        const recovered = currentAgentSnapshot();
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
        enterPhase("saved-input");
        releaseRecovery.resolve();
        await withinTest(savedInputStarted.promise, signal);
        enterPhase("fresh-input");
        const fresh = await gateway.client.request<{ runId: string }>("chat.send", ownerFreshInput);
        expect(ownerInputOrder).toEqual(["SAVED_OWNER"]);
        releaseSavedInput.resolve();
        expect(await rpc.wait(owner.sourceRunId)).toMatchObject({ status: "ok" });
        await withinTest(freshInputStarted.promise, signal);
        expect(await rpc.wait(fresh.runId)).toMatchObject({ status: "ok" });
        enterPhase("final-assertions");
        expect(ownerInputOrder).toEqual(["SAVED_OWNER", "FRESH_OWNER"]);
        expect(ownerAuthorizations).toEqual([`Bearer ${inheritedKey}`, `Bearer ${inheritedKey}`]);
        const history = await rpc.history(owner.sessionKey);
        expect(
          history.messages.flatMap((message) => {
            const row = message as { role: string; content: unknown };
            return row.role === "user"
              ? ["SAVED_OWNER", "FRESH_OWNER"].filter((marker) =>
                  JSON.stringify(row.content ?? null).includes(marker),
                )
              : [];
          }),
        ).toEqual(["SAVED_OWNER", "FRESH_OWNER"]);
        expect((await listSessionPendingInputs(owner)).items).toEqual([]);
        const inheritedSnapshot = currentAgentSnapshot("inheritor");
        expect(inheritedSnapshot).toBeDefined();
        expect(
          getPreparedModelRuntimeAuthStore(inheritedSnapshot!)?.profiles[inheritedProfile],
        ).toEqual({ type: "api_key", provider: inheritedProvider, key: inheritedKey });
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
      enterPhase("cleanup");
      unsubscribe?.();
      signal.removeEventListener("abort", releaseInspection);
      signal.removeEventListener("abort", reportAbort);
      releaseInspection();
      releaseRecovery.resolve();
      releaseSavedInput.resolve();
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
      reportPhase("complete");
    }
  }, 270_000);
});
