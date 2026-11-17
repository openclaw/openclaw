import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { loadPersistedPluginModelCatalogs } from "../agents/plugin-model-catalog-execution.js";
import * as catalogWorker from "../agents/prepared-model-catalog-worker.js";
import { listConfiguredOwnerInputs } from "../agents/prepared-model-runtime.configured.js";
import { getPreparedModelRuntimeSnapshot } from "../agents/prepared-model-runtime.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { waitForSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  retireSqliteDatabaseAdmissionForPath,
  revokeSqliteDatabaseAdmissionsForPath,
} from "../infra/sqlite-database-admission.js";
import { getActiveSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import {
  AgentDatabaseAdmissionError,
  assertAgentDatabaseAdmitted,
  readAgentDatabaseAdmissionRefusal,
  readAgentDatabaseReadAdmissionRefusal,
} from "../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import { assertOpenClawDatabasesReady } from "../state/openclaw-database-preflight.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { sendChatAndWait } from "./gateway-chat-fixture.test-support.js";
import { closeProvider, listenProvider } from "./gateway-provider-fixture.test-support.js";
import * as startupModels from "./server-startup-model-runtime.js";
import {
  prepareSessionMutationFacts,
  SessionMutationFactsUnavailableError,
  type PreparedSessionSourceFacts,
  type SessionFactsRead,
} from "./session-sharing-preparation.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildOpenAiResponsesTestModel } from "./test-openai-responses-model.js";

afterEach(() => vi.restoreAllMocks());

it("publishes custom-store reads before writable catalog birth and preserves later session authority", async ({
  signal,
}) => {
  await withOpenClawTestState(
    {
      label: "gateway-custom-store-catalog-birth",
      env: {
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("dist/extensions"),
      },
    },
    async (state) => {
      const agentId = "catalog-birth";
      const model = "grok-4.6";
      const reply = "READ_FIRST_CATALOG_REPLY";
      const requestedModels: string[] = [];
      const providerErrors: unknown[] = [];
      const storeTemplate = state.path(
        "custom",
        "agents",
        "{agentId}",
        "sessions",
        "sessions.json",
      );
      const storePath = storeTemplate.replace("{agentId}", agentId);
      const customDatabasePath = state.path(
        "custom",
        "agents",
        agentId,
        "agent",
        "openclaw-agent.sqlite",
      );
      const catalogDatabasePath = path.join(state.agentDir(agentId), "openclaw-agent.sqlite");
      const inspectionHeld = createDeferred();
      const releaseInspection = createDeferred();
      const normalPublication = createDeferred();
      const publication = createDeferred();
      const opening = createDeferred();
      const releaseOpening = createDeferred();
      const discoveryStarted = createDeferred();
      const mainCatalogStarted = createDeferred();
      const releaseMainCatalog = createDeferred();
      const discoveryCompleted = createDeferred();
      void publication.promise.catch(() => {});
      void normalPublication.promise.catch(() => {});
      const publishConfigured = startupModels.publishConfiguredModelRuntimeSnapshots;
      vi.spyOn(startupModels, "publishConfiguredModelRuntimeSnapshots").mockImplementation(
        async (params) => {
          try {
            await publishConfigured(params);
            normalPublication.resolve();
          } catch (error) {
            normalPublication.reject(error);
            throw error;
          }
        },
      );
      void discoveryCompleted.promise.catch(() => {});
      let catalogLoads = 0;
      const createWorker = catalogWorker.createPreparedModelCatalogWorker;
      vi.spyOn(catalogWorker, "createPreparedModelCatalogWorker").mockImplementation((params) => {
        const worker = createWorker(params);
        if (params.agentFacts.input.agentId === "main") {
          return {
            ...worker,
            async loadCatalog(...args: Parameters<typeof worker.loadCatalog>) {
              // Occupy the real catalog limiter; do not replace its scheduling behavior.
              mainCatalogStarted.resolve();
              await withinTest(releaseMainCatalog.promise, signal);
              return worker.loadCatalog(...args);
            },
          };
        }
        if (params.agentFacts.input.agentId !== agentId) {
          return worker;
        }
        return {
          ...worker,
          async loadCatalog(...args: Parameters<typeof worker.loadCatalog>) {
            catalogLoads += 1;
            discoveryStarted.resolve();
            try {
              const catalog = await worker.loadCatalog(...args);
              discoveryCompleted.resolve();
              return catalog;
            } catch (error) {
              discoveryCompleted.reject(error);
              throw error;
            }
          },
        };
      });
      const provider = createServer((request, response) => {
        if (request.method === "GET" && request.url === "/v1/models") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ data: [{ id: model }] }));
          return;
        }
        if (request.method === "POST" && request.url === "/v1/responses") {
          void (async () => {
            const payload: { model: string } = JSON.parse(await readRequestText(request));
            requestedModels.push(payload.model);
            expect(request.headers.authorization).toBe("Bearer synthetic-catalog-key");
            writeOpenAiResponsesText(response, {
              text: reply,
              messageId: "catalog-birth-reply",
              responseId: "catalog-birth-response",
            });
          })().catch((error: unknown) => {
            providerErrors.push(error);
            response.writeHead(500).end("synthetic provider failed");
          });
          return;
        }
        response.writeHead(404).end();
      });
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      let preparation: Promise<unknown> | undefined;
      let witness: SessionFactsRead<PreparedSessionSourceFacts> | undefined;
      try {
        const baseUrl = await listenProvider(provider);
        const cfg: OpenClawConfig = {
          agents: {
            ownership: "explicit",
            defaults: {
              workspace: state.workspaceDir,
              skipBootstrap: true,
              systemAgent: { agentId: "main" },
              model: "xai/grok-4.6",
            },
            entries: { main: {}, [agentId]: {} },
          },
          session: { store: storeTemplate },
          models: {
            mode: "replace",
            providers: {
              xai: {
                baseUrl,
                apiKey: "synthetic-catalog-key",
                api: "openai-responses",
                models: [buildOpenAiResponsesTestModel(model, 128_000, 256)],
              },
            },
          },
          plugins: {
            allow: ["xai"],
            slots: { memory: "none" },
            entries: { xai: { enabled: true } },
          },
          logging: { file: state.path("gateway.log") },
        };
        await state.writeConfig(cfg);
        await state.writeAuthProfiles({ version: 1, profiles: {} }, "main");
        const retainedScope = {
          agentId,
          storePath,
          env: state.env,
          sessionKey: `agent:${agentId}:retained-catalog-birth`,
          sessionId: "retained-catalog-birth-session",
        };
        const retainedSettings = { thinkingLevel: "off", verboseLevel: "on" };
        await upsertSessionEntryCore(retainedScope, {
          sessionId: retainedScope.sessionId,
          updatedAt: Date.now(),
          ...retainedSettings,
        });
        const retainedMessage = { role: "user", content: "Synthetic retained catalog history" };
        await persistSessionTranscriptTurn(retainedScope, {
          config: cfg,
          messages: [{ eventId: "retained-catalog-message", message: retainedMessage }],
          touchSessionEntry: false,
        });
        await waitForSessionTranscriptIndexReconcile({
          agentId,
          env: state.env,
          path: customDatabasePath,
        });
        const retainedTranscript = await loadTranscriptEvents(retainedScope);
        expect(retainedTranscript).toContainEqual(
          expect.objectContaining({ message: retainedMessage }),
        );
        await closeOpenClawAgentDatabasesAsync();
        closeOpenClawAgentDatabasesForTest();
        await closeStateDatabaseForTest();
        retireSqliteDatabaseAdmissionForPath(customDatabasePath);
        revokeSqliteDatabaseAdmissionsForPath(customDatabasePath);
        // An external journal-mode change requires deferred integrity, without changing schema.
        const database = new DatabaseSync(customDatabasePath);
        try {
          database.exec("PRAGMA journal_mode=DELETE");
        } finally {
          database.close();
        }
        await expect(fs.access(catalogDatabasePath)).rejects.toMatchObject({ code: "ENOENT" });
        gateway = await withAgentDatabaseStartupAdmission(async (admission) => {
          const scheduling = admission.scheduling.bind(admission);
          vi.spyOn(admission, "scheduling").mockImplementation((...args) => {
            const scheduled = scheduling(...args);
            return {
              ...scheduled,
              defer: (inspections, reason) =>
                scheduled.defer(
                  inspections.map((inspection) =>
                    inspection.target.agentId === agentId
                      ? {
                          ...inspection,
                          result: inspection.result.then(async (result) => {
                            inspectionHeld.resolve();
                            await withinTest(releaseInspection.promise, signal);
                            return result;
                          }),
                        }
                      : inspection,
                  ),
                  reason,
                ),
            };
          });
          const activate = admission.activate.bind(admission);
          vi.spyOn(admission, "activate").mockImplementation((activation) =>
            activate({
              ...activation,
              publishAgent: async (input) => {
                if (input.agentId !== agentId) {
                  return activation.publishAgent(input);
                }
                try {
                  await expect(fs.access(catalogDatabasePath)).rejects.toMatchObject({
                    code: "ENOENT",
                  });
                  const revoke = await activation.publishAgent(input);
                  publication.resolve();
                  return revoke;
                } catch (error) {
                  publication.reject(error);
                  throw error;
                }
              },
              openAgent: async (input) => {
                if (input.agentId !== agentId) {
                  return activation.openAgent(input);
                }
                opening.resolve();
                await withinTest(releaseOpening.promise, signal);
                return activation.openAgent(input);
              },
            }),
          );
          await assertOpenClawDatabasesReady({
            env: state.env,
            operation: "gateway-startup",
            config: cfg,
          });
          preparation = admission.pendingPreparation;
          expect(preparation).toBeDefined();
          const starting = startGatewayWithClient({
            cfg,
            configPath: state.configPath,
            token: "catalog-birth-test",
          });
          void starting.catch((error: unknown) => {
            normalPublication.reject(error);
            publication.reject(error);
          });
          try {
            await withinTest(
              Promise.all([inspectionHeld.promise, normalPublication.promise]),
              signal,
            );
            const mainInput = listConfiguredOwnerInputs(getRuntimeConfig(), undefined, true).find(
              (entry) => entry.agentId === "main",
            );
            expect(mainInput).toBeDefined();
            expect(mainInput && getPreparedModelRuntimeSnapshot(mainInput)).toBeDefined();
            expect(
              readAgentDatabaseReadAdmissionRefusal(agentId, { env: state.env }),
            ).toMatchObject({
              code: "agent-database-inspection-pending",
            });
            await expect(fs.access(catalogDatabasePath)).rejects.toMatchObject({ code: "ENOENT" });
            await withinTest(mainCatalogStarted.promise, signal);
            releaseInspection.resolve();
            // Normal startup has published; now the deferred agent must publish read-only facts.
            await withinTest(Promise.all([publication.promise, opening.promise]), signal);
            expect(
              readAgentDatabaseReadAdmissionRefusal(agentId, { env: state.env }),
            ).toBeUndefined();
            expect(() => assertAgentDatabaseAdmitted(agentId, { env: state.env })).toThrow(
              AgentDatabaseAdmissionError,
            );
            await expect(fs.access(catalogDatabasePath)).rejects.toMatchObject({
              code: "ENOENT",
            });
            const input = listConfiguredOwnerInputs(getRuntimeConfig(), undefined, true).find(
              (entry) => entry.agentId === agentId,
            );
            expect(input).toBeDefined();
            expect(input && getPreparedModelRuntimeSnapshot(input)).toBeDefined();
            expect(getActiveSecretsRuntimeSnapshot()?.authStores).toContainEqual(
              expect.objectContaining({ databasePath: catalogDatabasePath }),
            );
            releaseOpening.resolve();
            await withinTest(preparation!, signal);
            expect(readAgentDatabaseAdmissionRefusal(agentId, { env: state.env })).toBeUndefined();
            return await starting;
          } catch (error) {
            // Release test-owned holds before joining startup or its failure cleanup.
            releaseInspection.resolve();
            releaseOpening.resolve();
            releaseMainCatalog.resolve();
            const [started] = await Promise.allSettled([starting]);
            if (started.status === "fulfilled") {
              gateway = started.value;
            }
            throw error;
          }
        });
        expect(catalogLoads).toBe(0);
        const sessionKey = `agent:${agentId}:catalog-after-read`;
        witness = await prepareSessionMutationFacts({
          cfg: getRuntimeConfig(),
          sessionKey,
          agentId,
          allowMissing: true,
        });
        expect(witness.readCurrent(getRuntimeConfig()).target).toBeNull();
        releaseMainCatalog.resolve();
        await withinTest(discoveryStarted.promise, signal);
        expect(catalogLoads).toBe(1);
        await withinTest(discoveryCompleted.promise, signal);
        const catalogs = await loadPersistedPluginModelCatalogs(state.agentDir(agentId), ["xai"]);
        expect(catalogs.find(({ pluginId }) => pluginId === "xai")?.contents).toContain(model);
        expect(witness.readCurrent(getRuntimeConfig()).target).toBeNull();
        const created = await gateway.client.request<{ key: string; sessionId: string }>(
          "sessions.create",
          {
            agentId,
            key: sessionKey,
          },
        );
        expect(created).toMatchObject({ key: sessionKey, sessionId: expect.any(String) });
        const stored = await readSessionEntryReadOnlyInWorker({
          agentId,
          storePath,
          sessionKey,
          projection: "full",
        });
        expect(stored?.sessionId).toBe(created.sessionId);
        // This separate missing-entry witness must still reject an actual session mutation.
        expect(() => witness!.readCurrent(getRuntimeConfig())).toThrow(
          SessionMutationFactsUnavailableError,
        );
        await sendChatAndWait(gateway.client, sessionKey, "Reply with the synthetic marker.");
        expect(providerErrors).toEqual([]);
        expect(requestedModels).toEqual([model]);
        const history = await gateway.client.request<{ messages: unknown[] }>("chat.history", {
          sessionKey,
        });
        expect(history.messages).toContainEqual(
          expect.objectContaining({
            role: "assistant",
            content: expect.arrayContaining([
              expect.objectContaining({ type: "text", text: reply }),
            ]),
          }),
        );
        expect(
          await readSessionEntryReadOnlyInWorker({ ...retainedScope, projection: "full" }),
        ).toMatchObject({ sessionId: retainedScope.sessionId, ...retainedSettings });
        expect(await loadTranscriptEvents(retainedScope)).toEqual(retainedTranscript);
        expect(getRuntimeConfig().session?.store).toBe(storeTemplate);
      } finally {
        releaseInspection.resolve();
        releaseOpening.resolve();
        releaseMainCatalog.resolve();
        witness?.release();
        try {
          if (gateway) {
            await disconnectGatewayClient(gateway.client);
            await gateway.server.close();
          }
          await preparation;
        } finally {
          await closeProvider(provider);
        }
      }
    },
  );
});
