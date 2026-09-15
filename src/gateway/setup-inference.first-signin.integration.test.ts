import { afterEach, expect, it, vi } from "vitest";
import type { WizardNextResult } from "../../packages/gateway-protocol/src/index.js";
import { resolveAgentEffectiveModelPrimary } from "../agents/agent-scope.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store-runtime.js";
import * as catalogRefresh from "../agents/prepared-model-runtime.refresh-scope.js";
import { getRuntimeConfig } from "../config/config.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resetGatewayTestState } from "./gateway.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetGatewayTestState();
});

it(
  "activates the first device sign-in through openclaw.setup.auth.start and the embedded probe",
  { timeout: 90_000 },
  async () => {
    const requests: string[] = [];
    // Inventory refresh runs in another thread; the setup probe owns this test's transport.
    vi.spyOn(catalogRefresh, "refreshCommittedProviderCatalogs").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requests.push(`${url.origin}${url.pathname}`);
      switch (`${url.origin}${url.pathname}`) {
        case "https://github.com/login/device/code":
          return Response.json({
            device_code: "synthetic-device-code",
            user_code: "TEST-CODE",
            verification_uri: "https://github.com/login/device",
            expires_in: 600,
            interval: 1,
          });
        case "https://github.com/login/oauth/access_token":
          return Response.json({
            access_token: "synthetic-device-token",
            token_type: "bearer",
            scope: "read:user",
          });
        case "https://api.github.com/copilot_internal/user":
          return Response.json({ endpoints: { api: "https://api.individual.githubcopilot.com" } });
        case "https://api.individual.githubcopilot.com/models":
          return Response.json({
            data: [
              {
                id: "claude-sonnet-5",
                name: "Synthetic chat model",
                object: "model",
                vendor: "Anthropic",
                model_picker_enabled: true,
                capabilities: {
                  type: "chat",
                  limits: { max_context_window_tokens: 128_000, max_output_tokens: 4096 },
                  supports: { tool_calls: true },
                },
              },
            ],
          });
        case "https://api.individual.githubcopilot.com/v1/messages": {
          const events = [
            {
              type: "message_start",
              message: {
                id: "synthetic-message",
                type: "message",
                role: "assistant",
                model: "claude-sonnet-5",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 5, output_tokens: 0 },
              },
            },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
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
        default:
          throw new Error(`Unexpected setup request: ${url.origin}${url.pathname}`);
      }
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
        const recoveryRestart = vi.fn(() => {
          throw new Error("Setup must complete without a recovery restart");
        });
        const { client, server } = await startGatewayWithClient({
          configPath: state.configPath,
          token: "synthetic-gateway-token",
          scopes: ["operator.admin"],
          hotReloadRecovery: recoveryRestart,
          cfg: {
            gateway: {
              mode: "local",
              auth: { mode: "token", token: "synthetic-gateway-token" },
            },
            agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } },
            plugins: {
              slots: { memory: "none" },
              entries: { "github-copilot": { enabled: true } },
            },
            cron: { enabled: false },
            update: { checkOnStart: false },
          },
        });
        try {
          await server.startupSettled;
          const sessionId = "first-device-signin";
          await client.request("openclaw.setup.auth.start", {
            sessionId,
            agentId: "main",
            authChoice: "github-copilot",
            nativeSessionCatalogsEnabled: false,
          });
          let result = await client.request<WizardNextResult>("wizard.next", { sessionId });
          while (!result.done) {
            const step = result.step;
            if (!step) {
              throw new Error("Setup wizard did not return a step");
            }
            result = await client.request<WizardNextResult>("wizard.next", {
              sessionId,
              answer: { stepId: step.id, value: step.type === "confirm" ? true : null },
            });
          }
          expect(result, JSON.stringify(result)).toMatchObject({
            status: "done",
            modelActivation: { modelRef: "github-copilot/claude-sonnet-5" },
          });
          expect(
            requests.filter((url) => url === "https://github.com/login/oauth/access_token"),
          ).toHaveLength(1);
          expect(
            requests.filter(
              (url) => url === "https://api.individual.githubcopilot.com/v1/messages",
            ),
          ).toHaveLength(1);
          const profiles = Object.entries(
            loadAuthProfileStoreWithoutExternalProfiles(state.agentDir()).profiles,
          );
          expect(profiles).toHaveLength(1);
          const [profileId, credential] = profiles[0]!;
          expect(credential).toMatchObject({
            type: "token",
            provider: "github-copilot",
            tokenRef: { source: "store" },
          });
          expect(credential).not.toHaveProperty("setup");
          expect(recoveryRestart).not.toHaveBeenCalled();
          expect(resolveAgentEffectiveModelPrimary(getRuntimeConfig(), "main")).toBe(
            `github-copilot/claude-sonnet-5@${profileId}`,
          );
        } finally {
          await disconnectGatewayClient(client);
          await server.close({ reason: "first sign-in test complete" });
        }
      },
    );
  },
);
