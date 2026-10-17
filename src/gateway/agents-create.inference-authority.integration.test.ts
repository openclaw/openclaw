import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentsCreateResult } from "../../packages/gateway-protocol/src/schema/agents-create.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { rotateDeviceToken } from "../infra/device-pairing-tokens.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as profileCheck from "../system-agent/setup-inference-profile.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { resetGatewayTestState } from "./gateway.test-support.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const observation = vi.hoisted(() => ({ settled: (_options: GatewayRequestOptions) => {} }));

// A revoked socket can lose its reply; retain original exports and join the real handler.
vi.mock(
  "./server/ws-connection/authenticated-request-dispatch.server-methods.runtime.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("./server/ws-connection/authenticated-request-dispatch.server-methods.runtime.js")
      >();
    return {
      ...actual,
      handleGatewayRequest: async (...args: Parameters<typeof actual.handleGatewayRequest>) => {
        const settled = observation.settled;
        try {
          return await actual.handleGatewayRequest(...args);
        } finally {
          settled(args[0]);
        }
      },
    };
  },
);

afterEach(() => {
  observation.settled = () => {};
  vi.restoreAllMocks();
  resetGatewayTestState();
});

it(
  "fences agent creation inference by current caller authority through public WebSocket dispatch",
  { timeout: 90_000 },
  async ({ signal }) => {
    const requests: Array<{ method: string | undefined; url: string | undefined }> = [];
    const providerWork: Promise<void>[] = [];
    const {
      listener: providerServer,
      claim,
      releaseListener,
    } = await reserveTestPortListener({
      offsets: [0],
      signal,
      createListener: () =>
        createServer((request, response) => {
          const work = (async () => {
            for await (const chunk of request) {
              // Drain without retaining prompts or credentials.
              void chunk;
            }
            requests.push({ method: request.method, url: request.url });
            writeOpenAiResponsesText(response, {
              text: "OK",
              messageId: `msg_${randomUUID()}`,
              responseId: `resp_${randomUUID()}`,
            });
          })();
          providerWork.push(work);
          void work.catch((error: unknown) =>
            response.destroy(error instanceof Error ? error : new Error(String(error))),
          );
        }),
    });
    try {
      const address = providerServer.address();
      if (!address || typeof address === "string") {
        throw new Error("Synthetic provider did not bind");
      }
      const provider = buildMockOpenAiResponsesProvider(
        `http://127.0.0.1:${address.port}/v1`,
        "agent-creation-authority",
      );
      await withOpenClawTestState(
        {
          label: "agent-create-inference-authority",
          env: {
            OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
            OPENCLAW_SKIP_CHANNELS: "1",
            OPENCLAW_SKIP_CRON: "1",
            OPENCLAW_DISABLE_BONJOUR: "1",
            OPENCLAW_SKIP_GMAIL_WATCHER: "1",
            OPENCLAW_SKIP_CANVAS_HOST: "1",
            OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          },
        },
        async (state) => {
          const recoveryRestart = vi.fn(() => {
            throw new Error("Agent creation must complete without a recovery restart");
          });
          const { client, server, port } = await startGatewayWithClient({
            configPath: state.configPath,
            token: "synthetic-gateway-token",
            scopes: ["operator.admin"],
            hotReloadRecovery: recoveryRestart,
            cfg: {
              gateway: { mode: "local", auth: { mode: "token", token: "synthetic-gateway-token" } },
              agents: {
                entries: { main: {} },
                defaults: {
                  workspace: state.workspaceDir,
                  skipBootstrap: true,
                  heartbeat: { every: "0m" },
                  model: provider.modelRef,
                  models: {
                    [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
                  },
                },
              },
              models: {
                mode: "replace",
                catalogRefresh: { enabled: false },
                providers: {
                  [provider.providerId]: {
                    ...provider.config,
                    agentRuntime: { id: "openclaw" },
                    request: { allowPrivateNetwork: true },
                  },
                },
              },
              plugins: { enabled: false, slots: { memory: "none" } },
              cron: { enabled: false },
              update: { checkOnStart: false },
            },
          });
          const clients: Array<Awaited<ReturnType<typeof connectGatewayClient>>> = [];
          const connectDevice = async (label: string, scopes: string[]) => {
            const identity = loadOrCreateDeviceIdentity({ path: state.path(`${label}.sqlite`) });
            const pending = await requestDevicePairing({
              deviceId: identity.deviceId,
              publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
              clientId: "test",
              clientMode: "backend",
              role: "operator",
              scopes,
            });
            await approveDevicePairing(pending.request.requestId, {
              callerScopes: ["operator.admin"],
            });
            const rotated = await rotateDeviceToken({
              deviceId: identity.deviceId,
              role: "operator",
              scopes,
            });
            if (!rotated.ok) {
              throw new Error("Expected paired device token");
            }
            const connected = await connectGatewayClient({
              url: `ws://127.0.0.1:${port}`,
              mode: "backend",
              deviceIdentity: identity,
              deviceToken: rotated.entry.token,
              scopes,
            });
            clients.push(connected);
            return { connected, identity };
          };
          const createParams = (agentId: string) => ({
            agentId,
            name: "New agent",
            workspace: state.path(`${agentId}-workspace`),
            onboarding: true,
          });
          const expectNotCreated = async (agentId: string) => {
            expect(getRuntimeConfig().agents?.entries).not.toHaveProperty(agentId);
            await expect(fs.access(state.agentDir(agentId))).rejects.toMatchObject({
              code: "ENOENT",
            });
            await expect(fs.access(createParams(agentId).workspace)).rejects.toMatchObject({
              code: "ENOENT",
            });
          };
          try {
            await server.startupSettled;
            const beforeAllowed = requests.length;
            const allowed = await client.request<AgentsCreateResult>(
              "agents.create",
              createParams("bot-allowed"),
            );
            expect(allowed, JSON.stringify(allowed)).toMatchObject({
              agentId: "bot-allowed",
              onboarding: { status: "completed" },
            });
            expect(requests.slice(beforeAllowed)).toEqual([
              { method: "POST", url: "/v1/responses" },
            ]);
            const history = await client.request<{
              messages?: Array<{ role?: string; content?: unknown }>;
            }>("chat.history", { sessionKey: allowed.onboarding!.sessionKey });
            expect(history.messages).toEqual([
              expect.objectContaining({
                role: "assistant",
                content: [{ type: "text", text: "Hi! What would you like to call me?" }],
              }),
            ]);

            const readOnly = await connectDevice("read-only", ["operator.read"]);
            const beforeReadOnly = [...requests];
            await expect(
              readOnly.connected.request("agents.create", createParams("bot-read-only")),
            ).rejects.toThrow("missing scope: operator.admin");
            expect(requests).toEqual(beforeReadOnly);
            await expectNotCreated("bot-read-only");

            const owner = await connectDevice("revoked-owner", ["operator.admin"]);
            const reached = createDeferredCore();
            const release = createDeferredCore();
            const finished = createDeferredCore();
            const resolveProfile = profileCheck.resolveSetupInferenceProfileError;
            vi.spyOn(profileCheck, "resolveSetupInferenceProfileError").mockImplementationOnce(
              async (...args) => {
                const result = await resolveProfile(...args);
                expect(args[0].agentId).toBe("bot-revoked");
                // This await is inside the actual probe, after it prepared run admission.
                reached.resolve();
                await release.promise;
                return result;
              },
            );
            observation.settled = (options) => {
              if (options.req.method === "agents.create") {
                finished.resolve();
              }
            };
            const beforeRevocation = [...requests];
            const reply = owner.connected
              .request("agents.create", createParams("bot-revoked"))
              .then(
                (result) => ({ result }),
                (error: unknown) => ({ error }),
              );
            try {
              await withinTest(
                awaitGateBeforeSettlement(
                  reached.promise,
                  finished.promise,
                  "Creation settled before probe preparation barrier",
                ),
                signal,
              );
              await client.request("device.token.revoke", {
                deviceId: owner.identity.deviceId,
                role: "operator",
              });
              release.resolve();
              await withinTest(finished.promise, signal);
              expect(await reply).toHaveProperty("error");
              expect(requests).toEqual(beforeRevocation);
              await expectNotCreated("bot-revoked");
              expect(recoveryRestart).not.toHaveBeenCalled();
            } finally {
              release.resolve();
              await withinTest(Promise.all([finished.promise, reply]), signal);
            }
          } finally {
            for (const connected of clients) {
              await disconnectGatewayClient(connected);
            }
            await disconnectGatewayClient(client);
            await server.close({ reason: "agent creation authority proof complete" });
          }
        },
      );
    } finally {
      providerServer.closeAllConnections();
      try {
        await releaseListener();
        await Promise.all(providerWork);
      } finally {
        await claim.release();
      }
    }
  },
);
