import { once } from "node:events";
import { createServer } from "node:http";
import { text as readText } from "node:stream/consumers";
import { expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { runQaGatewayTestFixture } from "../../../test/helpers/qa-gateway-test-lifetime.js";
import { createOAuthManager } from "../../agents/auth-profiles/oauth-manager.js";
import * as oauthObservation from "../../agents/auth-profiles/oauth-refresh-observation.js";
import { loadPersistedAuthProfileStore } from "../../agents/auth-profiles/persisted.js";
import { runtimeAuthProfileRowsCache } from "../../agents/auth-profiles/runtime-snapshots.js";
import * as sqliteRead from "../../agents/auth-profiles/sqlite-read.js";
import { resolveAuthProfileDatabasePath } from "../../agents/auth-profiles/sqlite.js";
import type { AuthProfileStore, OAuthCredential } from "../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";

const PROVIDER = "oauth-cancel-fixture";
const MODEL = "selection-proof";
const PROFILE = `${PROVIDER}:owner`;
const REPLY = "OAUTH_CANCEL_SURVIVOR_OK";

type AgentResult = { runId: string; status: string; stopReason?: string };

it(
  "cancels one selecting Gateway run while its shared OAuth refresh and another run continue",
  { timeout: 120_000 },
  (context) => {
    let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let endpoint: ReturnType<typeof createServer> | undefined;
    const releaseReads = createDeferred();
    const readsCaptured = createDeferred();
    const providerEntered = createDeferred();
    const releaseProvider = createDeferred();
    const bothSelecting = createDeferred();
    const work: Promise<unknown>[] = [];
    const restoreReaders: Array<() => void> = [];

    return runQaGatewayTestFixture(
      context,
      async ({ signal, verifyCleanup }) => {
        state = await createOpenClawTestState({
          label: "gateway-oauth-cancel",
          verifyCleanup,
          env: {
            OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
            OPENCLAW_SKIP_CHANNELS: "1",
            OPENCLAW_SKIP_GMAIL_WATCHER: "1",
            OPENCLAW_SKIP_CRON: "1",
            OPENCLAW_SKIP_CANVAS_HOST: "1",
            OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          },
        });
        const waitForPhase = <T>(promise: Promise<T>, message: string) =>
          withTestTimeout(racePromiseWithAbortSignal(promise, signal), 20_000, message);
        const requests: Array<{ authorization?: string; body: string }> = [];
        endpoint = createServer((request, response) => {
          if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
            response.writeHead(404).end();
            return;
          }
          const inference = (async () => {
            requests.push({
              authorization: request.headers.authorization,
              body: await readText(request),
            });
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(
              `data: ${JSON.stringify({
                id: "chatcmpl-oauth-cancel",
                object: "chat.completion.chunk",
                created: 0,
                model: MODEL,
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", content: REPLY },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
              })}\n\ndata: [DONE]\n\n`,
            );
          })();
          work.push(inference);
          void inference.catch((error: unknown) => {
            response.destroy(error instanceof Error ? error : new Error(String(error)));
          });
        });
        endpoint.listen(0, "127.0.0.1");
        await once(endpoint, "listening");
        const address = endpoint.address();
        if (!address || typeof address === "string") {
          throw new Error("OAuth cancellation provider did not bind a loopback port");
        }
        const baseUrl = `http://127.0.0.1:${address.port}/v1`;
        await state.writeJson("provider/openclaw.plugin.json", {
          id: PROVIDER,
          providers: [PROVIDER],
          configSchema: { type: "object", additionalProperties: false },
        });
        const pluginPath = await state.writeText(
          "provider/index.cjs",
          `module.exports = {
            id: ${JSON.stringify(PROVIDER)}, register(api) {
              api.registerProvider({
                id: ${JSON.stringify(PROVIDER)}, label: "OAuth cancellation fixture", auth: [],
                formatApiKey: credential => credential.access,
                preferRuntimeResolvedModel: () => true,
                resolveDynamicModel: ctx => ({
                  ...ctx.providerConfig.models.find(model => model.id === ctx.modelId),
                  provider: ctx.provider, baseUrl: ctx.providerConfig.baseUrl,
                }),
              });
            },
          };`,
        );
        const token = "synthetic-oauth-cancel-gateway-token";
        const cfg = {
          agents: {
            defaults: {
              skipBootstrap: true,
              heartbeat: { every: "0m" },
              maxConcurrent: 2,
              model: { primary: `${PROVIDER}/${MODEL}` },
              utilityModel: "",
            },
            list: [{ id: "main", workspace: state.workspaceDir }],
          },
          models: {
            providers: {
              [PROVIDER]: {
                baseUrl,
                api: "openai-completions",
                request: { allowPrivateNetwork: true },
                models: [
                  {
                    id: MODEL,
                    name: MODEL,
                    api: "openai-completions",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 32768,
                    maxTokens: 1536,
                  },
                ],
              },
            },
          },
          tools: { profile: "minimal" },
          plugins: {
            allow: [PROVIDER],
            load: { paths: [pluginPath] },
            slots: { memory: "none" },
          },
          gateway: { mode: "local", auth: { mode: "token", token } },
        } satisfies OpenClawConfig;
        const credential: OAuthCredential = {
          type: "oauth",
          provider: PROVIDER,
          access: "synthetic-access-before",
          refresh: "synthetic-refresh-before",
          accountId: "synthetic-account",
          expires: Date.now() + 86_400_000,
        };
        const initialStore: AuthProfileStore = {
          version: 1,
          profiles: { [PROFILE]: credential },
        };
        await state.writeAuthProfiles(initialStore);
        gateway = await startGatewayWithClient({
          cfg,
          configPath: state.configPath,
          token,
          scopes: ["operator.admin"],
        });
        await gateway.server.startupSettled;
        const agentDir = state.agentDir();
        const databasePath = resolveAuthProfileDatabasePath(agentDir);
        let heldReads = 0;
        let returnedReads = 0;
        let enteredWaits = 0;
        let departedWaits = 0;
        const prepareReader = sqliteRead.prepareAgentAuthProfileRowsRead;
        const readerSpy = vi
          .spyOn(sqliteRead, "prepareAgentAuthProfileRowsRead")
          .mockImplementation((owner) => {
            const reader = prepareReader(owner);
            return {
              ...reader,
              read: async () => {
                const hold = owner.databasePath === databasePath && heldReads < 2;
                if (hold) {
                  heldReads += 1;
                }
                const rows = await reader.read();
                if (hold) {
                  returnedReads += 1;
                  if (returnedReads === 2) {
                    readsCaptured.resolve();
                  }
                  await releaseReads.promise;
                }
                return rows;
              },
            };
          });
        restoreReaders.push(() => readerSpy.mockRestore());
        const captureSettlement = oauthObservation.captureOAuthRefreshSettlement;
        const captureSpy = vi
          .spyOn(oauthObservation, "captureOAuthRefreshSettlement")
          .mockImplementation((params) => {
            const wait = captureSettlement(params);
            if (!wait || !params.databasePaths.includes(databasePath)) {
              return wait;
            }
            return async (...args: Parameters<typeof wait>) => {
              enteredWaits += 1;
              if (enteredWaits === 2) {
                bothSelecting.resolve();
              }
              try {
                await wait(...args);
              } finally {
                departedWaits += 1;
              }
            };
          });
        restoreReaders.push(() => captureSpy.mockRestore());
        // Begin from cold rows; the wrappers retain the actual read, admission, and cleanup.
        runtimeAuthProfileRowsCache.clear(databasePath);
        const client = gateway.client;
        const send = (name: string) => {
          const sessionKey = `agent:main:oauth-cancel-${name}`;
          const runId = `oauth-cancel-${name}`;
          const result = client.request<AgentResult>(
            "agent",
            { sessionKey, message: `Reply for ${name}.`, deliver: false, idempotencyKey: runId },
            { expectFinal: true, timeoutMs: 45_000 },
          );
          work.push(result);
          void result.catch(() => {});
          return { sessionKey, runId, result };
        };
        const cancelled = send("cancelled");
        const surviving = send("surviving");
        let survivorFinished = false;
        void surviving.result.then(
          () => {
            survivorFinished = true;
          },
          () => {
            survivorFinished = true;
          },
        );
        await waitForPhase(readsCaptured.promise, "Both Gateway selections did not capture rows");
        let refreshCalls = 0;
        let refreshFinished = false;
        const manager = createOAuthManager({
          canRefreshCredential: async () => true,
          readBootstrapCredential: () => null,
          buildApiKey: async (_provider, current) => current.access,
          refreshCredential: async () => {
            refreshCalls += 1;
            providerEntered.resolve();
            await releaseProvider.promise;
            return {
              ...credential,
              access: "synthetic-access-after",
              refresh: "synthetic-refresh-after",
              expires: Date.now() + 2 * 86_400_000,
            };
          },
        });
        const refresh = manager.resolveOAuthAccess({
          store: initialStore,
          profileId: PROFILE,
          credential,
          agentDir,
          forceRefresh: true,
        });
        work.push(refresh);
        void refresh.then(
          () => {
            refreshFinished = true;
          },
          () => {
            refreshFinished = true;
          },
        );
        await waitForPhase(providerEntered.promise, "OAuth refresh did not claim its credential");
        releaseReads.resolve();
        await waitForPhase(bothSelecting.promise, "Both runs did not enter captured settlement");
        expect(enteredWaits).toBe(2);
        expect(requests).toEqual([]);
        expect(refreshFinished).toBe(false);

        const aborted = await client.request("chat.abort", {
          sessionKey: cancelled.sessionKey,
          runId: cancelled.runId,
        });
        expect(aborted).toMatchObject({ aborted: true, runIds: [cancelled.runId] });
        let cancelledBeforeRelease: AgentResult | undefined;
        let cancellationFailure: unknown;
        try {
          cancelledBeforeRelease = await waitForPhase(
            cancelled.result,
            "Cancelled Gateway run still waits for OAuth settlement",
          );
        } catch (error) {
          cancellationFailure = error;
        }
        const waitBeforeRelease = await client.request("agent.wait", {
          runId: cancelled.runId,
          timeoutMs: 100,
        });
        expect(refreshFinished).toBe(false);
        expect(survivorFinished).toBe(false);
        expect(requests).toEqual([]);
        const departedBeforeRelease = departedWaits;

        releaseProvider.resolve();
        await expect(refresh).resolves.toMatchObject({ apiKey: "synthetic-access-after" });
        await expect(cancelled.result).resolves.toMatchObject({
          runId: cancelled.runId,
          status: "timeout",
          stopReason: "rpc",
        });
        await expect(surviving.result).resolves.toMatchObject({
          runId: surviving.runId,
          status: "ok",
        });
        const subsequent = send("subsequent");
        await expect(subsequent.result).resolves.toMatchObject({
          runId: subsequent.runId,
          status: "ok",
        });
        expect(refreshCalls).toBe(1);
        expect(loadPersistedAuthProfileStore(agentDir)?.profiles[PROFILE]).toMatchObject({
          type: "oauth",
          access: "synthetic-access-after",
          refresh: "synthetic-refresh-after",
        });
        expect(requests).toHaveLength(2);
        expect(requests.map((request) => request.authorization)).toEqual([
          "Bearer synthetic-access-after",
          "Bearer synthetic-access-after",
        ]);
        expect(requests[0]?.body).toContain("Reply for surviving.");
        expect(requests[1]?.body).toContain("Reply for subsequent.");
        const history = await client.request("chat.history", {
          sessionKey: surviving.sessionKey,
        });
        expect(JSON.stringify(history)).toContain(REPLY);
        console.info("OAUTH_CANCEL_GATEWAY_PROOF", {
          enteredWaits,
          departedBeforeRelease,
          waitBeforeRelease,
          cancelledBeforeRelease: cancelledBeforeRelease !== undefined,
          refreshCalls,
          inferenceRequests: requests.length,
          cancelledRunId: cancelled.runId,
          survivingRunId: surviving.runId,
          subsequentRunId: subsequent.runId,
        });
        expect(cancellationFailure).toBeUndefined();
        expect(cancelledBeforeRelease).toMatchObject({
          runId: cancelled.runId,
          status: "timeout",
          stopReason: "rpc",
        });
      },
      async () => {
        releaseReads.resolve();
        releaseProvider.resolve();
        await Promise.allSettled(work);
      },
      () => {
        for (const restore of restoreReaders.toReversed()) {
          restore();
        }
      },
      async () => {
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
        }
      },
      async () => {
        await gateway?.server.close();
      },
      async () => {
        const server = endpoint;
        if (server?.listening) {
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
      },
      async () => {
        await state?.cleanup();
      },
    );
  },
);
