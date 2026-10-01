import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type {
  PushLiveActivityPrepareResult,
  PushLiveActivityRegisterParams,
  PushLiveActivityRegistrationResult,
  UsersSelfResult,
} from "../../packages/gateway-protocol/src/index.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../src/config/config.js";
import {
  loadExactSessionEntryReadOnly,
  patchSessionEntryCore,
} from "../../src/config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../src/config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { OperatorScope } from "../../src/gateway/operator-scopes.js";
import { startGatewayServer } from "../../src/gateway/server.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getGatewayE2ePortBlock,
} from "../../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../../src/gateway/test-openai-responses-model.js";
import {
  onAgentRuntimeEvent,
  type AgentEventRuntimePayload,
} from "../../src/infra/agent-events.js";
import { getAgentRunContext } from "../../src/infra/agent-run-registry.js";
import { drainAgentRunTerminalWrites } from "../../src/infra/agent-run-terminal-writes.js";
import {
  loadOrCreateDeviceIdentity,
  loadOrCreateProcessDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  type DeviceIdentity,
} from "../../src/infra/device-identity.js";
import { approveDevicePairing } from "../../src/infra/device-pairing-approval.js";
import { approveNodePairing, requestNodePairing } from "../../src/infra/device-pairing-node.js";
import { requestDevicePairing } from "../../src/infra/device-pairing.js";
import type { ApnsLiveActivityPayload } from "../../src/infra/push-live-activity-payload.js";
import { readRow, type ActivityRow } from "../../src/infra/push-live-activity-store-state.js";
import { openOpenClawStateDatabase } from "../../src/state/openclaw-state-db.js";
import { ensureProfileForEmail, setUserProfileRole } from "../../src/state/user-profiles.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../src/test-utils/openclaw-test-state.js";
import { startQaGatewayRpcProxy } from "../fixtures/qa-gateway-rpc-proxy.mjs";
import { createDeferred } from "./promise.js";
import { runQaGatewayFixture } from "./qa-gateway-cleanup.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Activity fixture did not bind a loopback port");
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
}

export function createHeldActivityProvider(
  released: Promise<void>,
  onRequest: () => void,
  onReply: () => void,
) {
  const work = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    request.resume();
    const pending = (async () => {
      onRequest();
      await released;
      if (response.destroyed) {
        return;
      }
      const message = {
        type: "message",
        id: "activity-live-proof-reply",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Activity proof complete.", annotations: [] }],
      };
      onReply();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        [
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...message, status: "in_progress", content: [] },
          },
          { type: "response.output_item.done", output_index: 0, item: message },
          {
            type: "response.completed",
            response: {
              status: "completed",
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .concat("data: [DONE]\n\n")
          .join(""),
      );
    })()
      .catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => work.delete(pending));
    work.add(pending);
  });
  return { server, work };
}

type ActivityWireRequest = {
  relayHandle: string;
  purpose: "liveActivity";
  revision: number;
  pushType: "liveactivity";
  priority: number;
  payload: ApnsLiveActivityPayload["value"];
};
export type ActivityDelivery = {
  raw: string;
  wire: ActivityWireRequest;
  headers: IncomingHttpHeaders;
  method: string | undefined;
  url: string | undefined;
  at: number;
};
type DeviceName = "owner" | "second" | "foreign";
type RegisteredActivityFixture = {
  state: OpenClawTestState;
  session: { agentId: string; sessionKey: string };
  devices: Record<
    DeviceName,
    { identity: DeviceIdentity; email: string; profileId: string; scopes: string[] }
  >;
  gatewayIdentity: DeviceIdentity;
  deliveries: ActivityDelivery[];
  destination: (name: DeviceName) => PushLiveActivityRegisterParams["destination"];
  connect: (name: DeviceName) => ReturnType<typeof connectGatewayClient>;
  prepare: (name: DeviceName) => Promise<PushLiveActivityPrepareResult>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  row: (registrationId: string) => ActivityRow | undefined;
  replyWith: (status: 200 | 503) => void;
  startRun: () => Promise<PushLiveActivityPrepareResult>;
  register: (name: DeviceName) => Promise<PushLiveActivityRegistrationResult>;
  holdTerminal: () => Promise<void>;
  commitTerminal: () => Promise<void>;
};

export async function withRegisteredActivityFixture(
  body: (fixture: RegisteredActivityFixture) => Promise<void>,
): Promise<void> {
  await withOpenClawTestState(
    {
      scenario: "minimal",
      env: {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_APNS_RELAY_ALLOW_HTTP: "1",
      },
    },
    async (state) => {
      const releaseProvider = createDeferred();
      const releaseTerminal = createDeferred();
      const terminalEntered = createDeferred();
      const publicRunId = randomUUID();
      const session = { agentId: "main", sessionKey: `agent:main:activity-proof-${publicRunId}` };
      let providerRequests = 0;
      let providerReplies = 0;
      let internalRunId: string | undefined;
      let terminalEvent: AgentEventRuntimePayload | undefined;
      let blockedWrite: ReturnType<typeof patchSessionEntryCore> | undefined;
      let terminalDrain: Promise<void> | undefined;
      const stopTerminalObserver = onAgentRuntimeEvent((event) => {
        if (
          terminalEvent ||
          event.runId !== internalRunId ||
          event.stream !== "lifecycle" ||
          event.data.executionSettled !== true
        ) {
          return;
        }
        terminalEvent = event;
        blockedWrite = patchSessionEntryCore(
          session,
          async () => {
            terminalEntered.resolve();
            await releaseTerminal.promise;
            return null;
          },
          { skipMaintenance: true },
        );
      });
      const provider = createHeldActivityProvider(
        releaseProvider.promise,
        () => {
          providerRequests++;
        },
        () => {
          providerReplies++;
        },
      );
      const deliveries: ActivityDelivery[] = [];
      const recipientErrors: unknown[] = [];
      const recipientWork = new Set<Promise<void>>();
      let responseStatus = 200;
      const recipient = createServer((request, response) => {
        const pending = (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
          }
          const raw = Buffer.concat(chunks).toString("utf8");
          const wire: ActivityWireRequest = JSON.parse(raw);
          deliveries.push({
            raw,
            wire,
            headers: request.headers,
            method: request.method,
            url: request.url,
            at: Date.now(),
          });
          response.writeHead(responseStatus, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: responseStatus === 200, status: responseStatus }));
        })()
          .catch((error: unknown) => {
            recipientErrors.push(error);
            response.destroy();
          })
          .finally(() => recipientWork.delete(pending));
        recipientWork.add(pending);
      });
      let gateway: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
      const clients = new Map<string, Awaited<ReturnType<typeof connectGatewayClient>>>();
      const proxies: Array<Awaited<ReturnType<typeof startQaGatewayRpcProxy>>> = [];
      const stopGateway = async () => {
        const closingClients = [...clients.values()];
        clients.clear();
        const closingProxies = proxies.splice(0);
        await runQaGatewayFixture(
          () => Promise.resolve(),
          ...closingClients.map((client) => () => disconnectGatewayClient(client)),
          ...closingProxies.map((proxy) => () => proxy.stop()),
          async () => {
            await gateway?.close();
            gateway = undefined;
          },
        );
      };
      await runQaGatewayFixture(
        async () => {
          const providerPort = await listen(provider.server);
          const relayOrigin = `http://127.0.0.1:${await listen(recipient)}`;
          const model = buildMockOpenAiResponsesProvider(`http://127.0.0.1:${providerPort}/v1`);
          const owner = ensureProfileForEmail("activity-owner@example.test");
          const foreign = ensureProfileForEmail("activity-foreign@example.test");
          setUserProfileRole(owner.id, "maintainer");
          setUserProfileRole(foreign.id, "writer");
          const ownerScopes: OperatorScope[] = ["operator.admin", "operator.pairing"];
          const foreignScopes: OperatorScope[] = ["operator.read", "operator.write"];
          const devices = {
            owner: {
              identity: loadOrCreateDeviceIdentity({ path: state.statePath("owner.sqlite") }),
              email: "activity-owner@example.test",
              profileId: owner.id,
              scopes: ownerScopes,
            },
            second: {
              identity: loadOrCreateDeviceIdentity({ path: state.statePath("second.sqlite") }),
              email: "activity-owner@example.test",
              profileId: owner.id,
              scopes: ownerScopes,
            },
            foreign: {
              identity: loadOrCreateDeviceIdentity({ path: state.statePath("foreign.sqlite") }),
              email: "activity-foreign@example.test",
              profileId: foreign.id,
              scopes: foreignScopes,
            },
          };
          for (const device of Object.values(devices)) {
            const pairing = await requestDevicePairing(
              {
                deviceId: device.identity.deviceId,
                publicKey: publicKeyRawBase64UrlFromPem(device.identity.publicKeyPem),
                role: "operator",
                roles: ["operator", "node"],
                scopes: device.scopes,
                clientId: GATEWAY_CLIENT_NAMES.IOS_APP,
                clientMode: GATEWAY_CLIENT_MODES.UI,
                platform: "ios",
                deviceFamily: "iPhone",
              },
              state.stateDir,
            );
            expect(
              await approveDevicePairing(
                pairing.request.requestId,
                { callerScopes: ownerScopes },
                state.stateDir,
              ),
            ).toMatchObject({ status: "approved" });
            const node = await requestNodePairing(
              { nodeId: device.identity.deviceId, platform: "ios", commands: [] },
              state.stateDir,
            );
            expect(
              await approveNodePairing(
                node.request.requestId,
                { callerScopes: ownerScopes },
                state.stateDir,
              ),
            ).toHaveProperty("node.nodeId", device.identity.deviceId);
          }
          const config: OpenClawConfig = {
            agents: {
              defaults: {
                workspace: state.workspaceDir,
                skipBootstrap: true,
                model: { primary: model.modelRef },
                models: {
                  [model.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
                },
              },
              entries: { main: { default: true } },
            },
            models: { mode: "replace", providers: { [model.providerId]: model.config } },
            gateway: {
              auth: {
                mode: "trusted-proxy",
                identityScopes: {
                  [devices.owner.email]: ownerScopes,
                  [devices.foreign.email]: foreignScopes,
                },
                trustedProxy: {
                  userHeader: "x-forwarded-user",
                  requiredHeaders: ["x-forwarded-proto"],
                  allowLoopback: true,
                },
              },
              trustedProxies: ["127.0.0.1"],
              roles: {
                default: "writer",
                definitions: {
                  maintainer: { sessions: { others: "write" }, agents: "*", scopes: ownerScopes },
                  writer: { sessions: { others: "none" }, agents: "*", scopes: foreignScopes },
                },
              },
              push: { apns: { relay: { baseUrl: relayOrigin } } },
            },
          };
          await state.writeConfig(config);
          const port = await getGatewayE2ePortBlock();
          const gatewayIdentity = loadOrCreateProcessDeviceIdentity();
          const start = async () => {
            clearRuntimeConfigSnapshot();
            clearConfigCache();
            clearSessionStoreCacheForTest();
            gateway = await startGatewayServer(port, {
              bind: "loopback",
              auth: config.gateway?.auth,
              controlUiEnabled: false,
            });
          };
          const connect = async (name: keyof typeof devices) => {
            const existing = clients.get(name);
            if (existing) {
              return existing;
            }
            const device = devices[name];
            const proxy = await startQaGatewayRpcProxy({
              backendPort: port,
              repoRoot: fileURLToPath(new URL("../../", import.meta.url)),
              upstreamHeaders: {
                "x-forwarded-user": device.email,
                "x-forwarded-proto": "https",
                "x-forwarded-for": "203.0.113.50",
              },
            });
            proxies.push(proxy);
            const client = await connectGatewayClient({
              url: proxy.url,
              deviceIdentity: device.identity,
              clientName: GATEWAY_CLIENT_NAMES.IOS_APP,
              mode: GATEWAY_CLIENT_MODES.UI,
              platform: "ios",
              deviceFamily: "iPhone",
              scopes: device.scopes,
            });
            clients.set(name, client);
            expect(await client.request<UsersSelfResult>("users.self", {})).toMatchObject({
              profile: { id: device.profileId },
            });
            return client;
          };
          const prepare = async (name: keyof typeof devices) => {
            const entry = loadExactSessionEntryReadOnly(session)?.entry;
            if (!entry?.sessionId) {
              throw new Error("The registered proof requires a committed session");
            }
            return await (
              await connect(name)
            ).request<PushLiveActivityPrepareResult>("push.liveActivity.prepare", {
              key: session.sessionKey,
              agentId: session.agentId,
              sessionId: entry.sessionId,
              publicRunId,
            });
          };
          const destination = (
            name: DeviceName,
          ): PushLiveActivityRegisterParams["destination"] => ({
            transport: "relay",
            topic: "ai.openclaw.ios",
            environment: "sandbox",
            relayHandle: `handle-${name}`,
            sendGrant: `fixture-grant-${name}`,
            installationId: `installation-${name}`,
            relayOrigin,
            relayRevision: 1,
          });
          const fixture = {
            state,
            session,
            devices,
            gatewayIdentity,
            deliveries,
            destination,
            connect,
            prepare,
            start,
            stop: stopGateway,
            row: (registrationId: string) =>
              readRow(openOpenClawStateDatabase().db, registrationId),
            replyWith: (status: 200 | 503) => {
              responseStatus = status;
            },
            startRun: async () => {
              const client = await connect("owner");
              expect(
                await client.request("chat.send", {
                  sessionKey: session.sessionKey,
                  message: "Return a short acknowledgement.",
                  deliver: false,
                  idempotencyKey: publicRunId,
                }),
              ).toMatchObject({ runId: publicRunId, status: "started" });
              await expect.poll(() => providerRequests, { timeout: 30_000 }).toBeGreaterThan(0);
              await expect
                .poll(() => loadExactSessionEntryReadOnly(session)?.entry, { timeout: 30_000 })
                .toMatchObject({ status: "running", lifecycleRunId: expect.any(String) });
              internalRunId = loadExactSessionEntryReadOnly(session)?.entry.lifecycleRunId;
              expect(providerReplies).toBe(0);
              return await prepare("owner");
            },
            register: async (name: keyof typeof devices) => {
              const prepared = await prepare(name);
              const registered = await (
                await connect(name)
              ).request<PushLiveActivityRegistrationResult>("push.liveActivity.register", {
                activityId: `activity-${name}`,
                expected: {
                  binding: prepared.binding,
                  sourceIncarnation: prepared.sourceIncarnation,
                },
                destination: destination(name),
              });
              expect(registered.binding).toEqual(prepared.binding);
              return registered;
            },
            holdTerminal: async () => {
              releaseProvider.resolve();
              await expect.poll(() => terminalEvent, { timeout: 30_000 }).toBeDefined();
              await terminalEntered.promise;
              const root = internalRunId && getAgentRunContext(internalRunId)?.delegatedAuthority;
              if (!root) {
                throw new Error("The held terminal lost its admitted producer");
              }
              terminalDrain = drainAgentRunTerminalWrites(root.operationalRunInstance);
              expect(loadExactSessionEntryReadOnly(session)?.entry.status).toBe("running");
            },
            commitTerminal: async () => {
              releaseTerminal.resolve();
              await blockedWrite;
              await terminalDrain;
              await expect
                .poll(() => loadExactSessionEntryReadOnly(session)?.entry)
                .toMatchObject({ status: "done", lastRunId: publicRunId });
            },
          };
          await start();
          await body(fixture);
          expect(recipientErrors).toEqual([]);
        },
        async () => {
          releaseProvider.resolve();
          releaseTerminal.resolve();
          stopTerminalObserver();
          await Promise.all([blockedWrite, terminalDrain]);
        },
        stopGateway,
        async () => {
          await closeServer(provider.server);
          await Promise.all(provider.work);
        },
        async () => {
          await closeServer(recipient);
          await Promise.all(recipientWork);
        },
      );
    },
  );
}
