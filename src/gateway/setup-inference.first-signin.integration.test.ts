import { afterEach, expect, it, vi } from "vitest";
import type { WizardNextResult } from "../../packages/gateway-protocol/src/index.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
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
import { resetGatewayTestState } from "./gateway.test-support.js";
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
  "replaces same-owner device sign-in, preserves other owners, and fences revoked retries through WebSocket",
  { timeout: 90_000 },
  async ({ signal }) => {
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
            name: "Synthetic chat model",
            vendor: "Anthropic",
            model_picker_enabled: true,
            capabilities: {
              type: "chat",
              limits: { max_context_window_tokens: 128_000, max_output_tokens: 4096 },
              supports: { tool_calls: true },
            },
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
        return new Response(
          events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
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
        const scopes = ["operator.admin"];
        const recoveryRestart = vi.fn(() => {
          throw new Error("Setup must complete without a recovery restart");
        });
        const { client, server, port } = await startGatewayWithClient({
          configPath: state.configPath,
          token: "synthetic-gateway-token",
          scopes,
          hotReloadRecovery: recoveryRestart,
          cfg: {
            gateway: {
              mode: "local",
              auth: { mode: "token", token: "synthetic-gateway-token" },
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
        try {
          await server.startupSettled;
          const identity = loadOrCreateDeviceIdentity({ path: state.path("setup-owner.sqlite") });
          const pending = await requestDevicePairing({
            deviceId: identity.deviceId,
            publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
            clientId: "test",
            clientMode: "backend",
            role: "operator",
            scopes,
          });
          await approveDevicePairing(pending.request.requestId, { callerScopes: scopes });
          const rotated = await rotateDeviceToken({
            deviceId: identity.deviceId,
            role: "operator",
            scopes,
          });
          if (!rotated.ok) {
            throw new Error("Expected setup owner device token");
          }
          // Backend clients keep device ownership; the admin client uses the Gateway owner profile.
          owner = await connectGatewayClient({
            mode: "backend",
            url: `ws://127.0.0.1:${port}`,
            deviceIdentity: identity,
            deviceToken: rotated.entry.token,
            scopes,
          });
          const auth = {
            agentId: "main",
            authChoice: "github-copilot",
            nativeSessionCatalogsEnabled: false,
          };
          const readProfiles = () =>
            loadAuthProfileStoreWithoutExternalProfiles(state.agentDir()).profiles;
          const setupOwner = owner;
          const startSignIn = async (sessionId: string) => {
            await setupOwner.request("openclaw.setup.auth.start", { ...auth, sessionId });
            return await setupOwner.request<WizardNextResult>("wizard.next", { sessionId });
          };
          const expectPending = (result: WizardNextResult) =>
            expect(result).toMatchObject({ done: false, step: { id: expect.any(String) } });
          const abandoned = await startSignIn("abandoned-signin");
          expectPending(abandoned);
          await expect(
            client.request("openclaw.setup.auth.start", { ...auth, sessionId: "different-owner" }),
          ).rejects.toThrow("OpenClaw setup is already in progress");
          expect(await owner.request("wizard.next", { sessionId: "abandoned-signin" })).toEqual(
            abandoned,
          );
          expect(readProfiles()).toEqual({});

          const sessionId = "replacement-signin";
          let result = await startSignIn(sessionId);
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
          const reply = owner
            .request("openclaw.setup.auth.start", { ...auth, sessionId: "revoked-retry" })
            .then(
              (value) => ({ result: value }),
              (error: unknown) => ({ error }),
            );
          try {
            await withinTest(
              awaitGateBeforeSettlement(
                reached.promise,
                finished.promise,
                "Retry finished before settlement barrier",
              ),
              signal,
            );
            await client.request("device.token.revoke", {
              deviceId: identity.deviceId,
              role: "operator",
            });
            release.resolve();
            const sessions = await withinTest(finished.promise, signal);
            expect(await reply).toHaveProperty("error");
            expect(sessions).not.toContain("revoked-retry");
            expect(requests).toEqual(beforeRevocation);
            expect(readProfiles()).toEqual(savedProfiles);
            expectActivation();
          } finally {
            release.resolve();
            await withinTest(Promise.all([finished.promise, reply]), signal);
          }
        } finally {
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
