import { X509Certificate } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createAnthropicResponse } from "../../packages/ai/src/provider-transport-parity.test-support.js";
import type { WizardNextResult } from "../../packages/gateway-protocol/src/index.js";
import {
  GATEWAY_OWNER_PROFILE_ID,
  type UsersSelfResult,
} from "../../packages/gateway-protocol/src/schema/users.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { resolveAgentEffectiveModelPrimary } from "../agents/agent-scope.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store-runtime.js";
import * as catalogRefresh from "../agents/prepared-model-runtime.refresh-scope.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { rotateDeviceToken } from "../infra/device-pairing-tokens.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { resetGatewayTestState } from "./gateway.test-support.js";
import type { OperatorScope } from "./operator-scopes.js";
import * as setupAdmission from "./server-methods/setup-admission.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";

const observation = vi.hoisted(() => ({ settled: (_options: GatewayRequestOptions) => {} }));

// A revoked socket can lose its reply. Join the real handler before checking effects.
vi.mock(
  "./server/ws-connection/authenticated-request-dispatch.server-methods.runtime.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("./server/ws-connection/authenticated-request-dispatch.server-methods.runtime.js")
      >();
    return {
      ...actual,
      handleGatewayRequest: (...args: Parameters<typeof actual.handleGatewayRequest>) => {
        const settled = observation.settled;
        return actual.handleGatewayRequest(...args).finally(() => settled(args[0]));
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
  "replaces same-owner sign-in, preserves other owners, and fences revoked retries through WebSocket",
  { timeout: 90_000 },
  async ({ signal }) => {
    const join = <T>(work: PromiseLike<T>) => withinTest(work, signal);
    const requests: string[] = [];
    // Inventory refresh runs in another thread; the setup probe owns this test's transport.
    vi.spyOn(catalogRefresh, "refreshCommittedProviderCatalogs").mockImplementation(() => {});
    const responses: Record<string, unknown> = {
      "https://github.com/login/device/code": {
        device_code: "synthetic-device-code",
        user_code: "TEST-CODE",
        verification_uri: "https://github.com/login/device",
        expires_in: 600,
        interval: 1,
      },
      "https://github.com/login/oauth/access_token": {
        access_token: "synthetic-device-token",
      },
      "https://api.github.com/copilot_internal/user": {
        endpoints: { api: "https://api.individual.githubcopilot.com" },
      },
      "https://api.individual.githubcopilot.com/models": {
        data: [
          {
            id: "claude-sonnet-5",
            model_picker_enabled: true,
            capabilities: { supports: { tool_calls: true } },
          },
        ],
      },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const endpoint = `${url.origin}${url.pathname}`;
      requests.push(endpoint);
      if (Object.hasOwn(responses, endpoint)) {
        return Response.json(responses[endpoint]);
      }
      if (endpoint === "https://api.individual.githubcopilot.com/v1/messages") {
        const events = [
          {
            type: "message_start",
            message: {
              id: "synthetic-message",
              model: "claude-sonnet-5",
              usage: { input_tokens: 5, output_tokens: 0 },
            },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          },
          { type: "message_stop" },
        ];
        return createAnthropicResponse(events);
      }
      throw new Error(`Unexpected setup request: ${endpoint}`);
    });
    await withOpenClawTestState(
      {
        label: "setup-first-signin",
        env: {
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_DISABLE_BONJOUR: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          COPILOT_GITHUB_TOKEN: undefined,
        },
      },
      async (state) => {
        const scopes: OperatorScope[] = ["operator.admin"];
        const recoveryRestart = vi.fn(() => {
          throw new Error("Setup must complete without a recovery restart");
        });
        const origin = "https://setup.example.test";
        const authConfig = {
          mode: "trusted-proxy" as const,
          trustedProxy: {
            userHeader: "x-forwarded-user",
            requiredHeaders: ["x-forwarded-proto"],
            allowLoopback: true,
            deviceAutoApprove: { enabled: true, scopes },
          },
          identityScopes: { "other-owner@example.test": scopes },
        };
        const tlsFingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
        const certPath = await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM);
        const keyPath = await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM);
        const { client, server, port } = await startGatewayWithClient({
          configPath: state.configPath,
          auth: authConfig,
          secure: true,
          tlsFingerprint,
          clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
          mode: GATEWAY_CLIENT_MODES.WEBCHAT,
          origin,
          edgeAuthHeaders: {
            "x-forwarded-for": "203.0.113.50",
            "x-forwarded-proto": "https",
            "x-forwarded-user": "other-owner@example.test",
          },
          scopes,
          hotReloadRecovery: recoveryRestart,
          cfg: {
            gateway: {
              mode: "local",
              auth: authConfig,
              trustedProxies: ["127.0.0.1"],
              controlUi: { allowedOrigins: [origin] },
              tls: { enabled: true, autoGenerate: false, certPath, keyPath },
            },
            agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } },
            plugins: {
              allow: ["github-copilot"],
              slots: { memory: "none" },
              entries: { "github-copilot": { enabled: true } },
            },
            cron: { enabled: false },
            update: { checkOnStart: false },
          },
        });
        let owner: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
        let sameOwner: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
        try {
          await server.startupSettled;
          const connectOwner = async (label: string) => {
            const identity = loadOrCreateDeviceIdentity({
              path: state.path(label, "device.sqlite"),
            });
            const device = { deviceId: identity.deviceId, role: "operator", scopes };
            const pending = await requestDevicePairing({
              ...device,
              publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
              clientId: "test",
              clientMode: "backend",
            });
            await approveDevicePairing(pending.request.requestId, { callerScopes: scopes });
            const rotated = await rotateDeviceToken(device);
            if (!rotated.ok) {
              throw new Error("Expected setup owner device token");
            }
            const actor = await connectGatewayClient({
              mode: "backend",
              url: `wss://127.0.0.1:${port}`,
              tlsFingerprint,
              deviceIdentity: identity,
              deviceToken: rotated.entry.token,
              scopes,
            });
            return { actor, device };
          };
          // Paired backend devices share the Gateway owner; the proxy authenticates a person.
          const initialOwner = await connectOwner("setup-owner");
          owner = initialOwner.actor;
          const { device } = initialOwner;
          sameOwner = (await connectOwner("replacement-owner")).actor;
          const auth = {
            agentId: "main",
            authChoice: "github-copilot",
            nativeSessionCatalogsEnabled: false,
          };
          const readProfiles = () =>
            loadAuthProfileStoreWithoutExternalProfiles(state.agentDir()).profiles;
          const setupOwner = owner;
          for (const actor of [setupOwner, sameOwner]) {
            const self = await actor.request<UsersSelfResult>("users.self", {});
            expect(self.profile.id).toBe(GATEWAY_OWNER_PROFILE_ID);
          }
          const otherSelf = await client.request<UsersSelfResult>("users.self", {});
          expect(otherSelf.profile.id).not.toBe(GATEWAY_OWNER_PROFILE_ID);
          const start = (sessionId: string, actor = setupOwner) =>
            actor.request("openclaw.setup.auth.start", { ...auth, sessionId });
          const startSignIn = async (sessionId: string, actor = setupOwner) => {
            await start(sessionId, actor);
            return await actor.request<WizardNextResult>("wizard.next", { sessionId });
          };
          const expectPending = (result: WizardNextResult) =>
            expect(result).toMatchObject({ done: false, step: { id: expect.any(String) } });
          const abandoned = await startSignIn("abandoned-signin");
          expectPending(abandoned);
          expect(await owner.request("wizard.next", { sessionId: "abandoned-signin" })).toEqual(
            abandoned,
          );
          expect(readProfiles()).toEqual({});

          const beforeForeignStart = [...requests];
          for (const [foreignSessionId, message] of [
            [
              "different-owner",
              "OpenClaw setup is already in progress; try again when it finishes.",
            ],
            ["abandoned-signin", "wizard session already exists"],
          ] as const) {
            const foreignSettled = createDeferredCore<string[]>();
            observation.settled = (options) => {
              if (options.req.method === "openclaw.setup.auth.start") {
                foreignSettled.resolve([...options.context.wizardSessions.keys()]);
              }
            };
            await expect(start(foreignSessionId, client)).rejects.toThrow(message);
            expect(await join(foreignSettled.promise)).toEqual(["abandoned-signin"]);
            expect(await owner.request("wizard.next", { sessionId: "abandoned-signin" })).toEqual(
              abandoned,
            );
            expect(requests).toEqual(beforeForeignStart);
            expect(readProfiles()).toEqual({});
          }
          observation.settled = () => {};

          const sessionId = "replacement-signin";
          let result = await startSignIn(sessionId, sameOwner);
          while (!result.done) {
            const step = result.step;
            if (!step) {
              throw new Error("Setup wizard did not return a step");
            }
            result = await owner.request<WizardNextResult>("wizard.next", {
              sessionId,
              answer: { stepId: step.id, value: step.type === "confirm" ? true : null },
            });
          }
          expect(result, JSON.stringify(result)).toMatchObject({
            status: "done",
            modelActivation: { modelRef: "github-copilot/claude-sonnet-5" },
          });
          for (const endpoint of [
            "https://github.com/login/oauth/access_token",
            "https://api.individual.githubcopilot.com/v1/messages",
          ]) {
            expect(requests.filter((url) => url === endpoint)).toHaveLength(1);
          }
          const savedProfiles = readProfiles();
          const profiles = Object.entries(savedProfiles);
          expect(profiles).toHaveLength(1);
          const [profileId, credential] = profiles[0]!;
          expect(credential).toMatchObject({
            type: "token",
            provider: "github-copilot",
            tokenRef: { source: "store" },
          });
          expect(credential).not.toHaveProperty("setup");
          const expectActivation = () => {
            expect(recoveryRestart).not.toHaveBeenCalled();
            expect(resolveAgentEffectiveModelPrimary(getRuntimeConfig(), "main")).toBe(
              `github-copilot/claude-sonnet-5@${profileId}`,
            );
          };
          expectActivation();
          // Cancellation requires a pending prompt, not a provider-specific prompt sequence.
          expectPending(await startSignIn("before-revocation"));
          const beforeRevocation = [...requests];
          const reached = createDeferredCore();
          const release = createDeferredCore();
          const finished = createDeferredCore<string[]>();
          const whenSettled = setupAdmission.whenAdmittedWizardSessionSettled;
          // Hold only the retry's existing settlement await; cancellation and lock release stay real.
          vi.spyOn(setupAdmission, "whenAdmittedWizardSessionSettled").mockImplementationOnce(
            async (session) => {
              await whenSettled(session);
              reached.resolve();
              await release.promise;
            },
          );
          observation.settled = (options) => {
            if (options.req.method === "openclaw.setup.auth.start") {
              finished.resolve([...options.context.wizardSessions.keys()]);
            }
          };
          const reply = start("revoked-retry").then(
            (value) => ({ result: value }),
            (error: unknown) => ({ error }),
          );
          try {
            await join(
              awaitGateBeforeSettlement(
                reached.promise,
                finished.promise,
                "Retry finished before settlement barrier",
              ),
            );
            await client.request("device.token.revoke", {
              deviceId: device.deviceId,
              role: device.role,
            });
            release.resolve();
            const sessions = await join(finished.promise);
            expect(await reply).toHaveProperty("error");
            expect(sessions).not.toContain("revoked-retry");
            expect(requests).toEqual(beforeRevocation);
            expect(readProfiles()).toEqual(savedProfiles);
            expectActivation();
          } finally {
            release.resolve();
            await join(Promise.all([finished.promise, reply]));
          }
        } finally {
          if (sameOwner) {
            await disconnectGatewayClient(sameOwner);
          }
          if (owner) {
            await disconnectGatewayClient(owner);
          }
          await disconnectGatewayClient(client);
          await server.close({ reason: "first sign-in test complete" });
        }
      },
    );
  },
);
