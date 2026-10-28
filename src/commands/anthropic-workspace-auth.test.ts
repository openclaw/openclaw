import path from "node:path";
import { createApiRegistry, createNodeLlmRuntime } from "@openclaw/ai";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import { describe, expect, it, vi } from "vitest";
import { buildAnthropicProvider } from "../../extensions/anthropic/api.js";
import {
  createEmptyAgentDiscoveryStores,
  resolveModelAsync,
} from "../agents/embedded-agent-runner/model.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyProviderAuthConfigPatchWithNormalization as applyProviderAuthConfigPatch } from "../plugins/provider-auth-choice-helpers.js";
import type { ProviderAuthContext } from "../plugins/types.js";
import { createRuntimeEnv } from "../test-utils/plugin-runtime-env.js";
import { createTestWizardPrompter } from "../test-utils/plugin-setup-wizard.js";

const workspaceId = "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ";
const apiKey = "sk-ant-api03-workspace-test-not-real";
const modelId = "claude-sonnet-4-6";
const model = {
  id: modelId,
  name: modelId,
  reasoning: false,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 32,
};
const config: OpenClawConfig = {
  models: {
    providers: {
      anthropic: {
        baseUrl: "https://api.anthropic.com",
        api: "anthropic-messages",
        headers: { "X-Route": "preserve" },
        models: [model],
      },
    },
  },
};

function authContext(
  cfg: OpenClawConfig,
  text: ProviderAuthContext["prompter"]["text"],
): ProviderAuthContext {
  return {
    config: cfg,
    env: {},
    opts: { anthropicApiKey: apiKey },
    workspaceDir: path.resolve("agent-local-workspace"),
    prompter: createTestWizardPrompter({ text }),
    runtime: createRuntimeEnv(),
    secretInputMode: "plaintext",
    isRemote: false,
    openUrl: vi.fn(async () => {}),
    oauth: {
      createVpsAwareHandlers: vi.fn<ProviderAuthContext["oauth"]["createVpsAwareHandlers"]>(),
    },
  };
}

function apiKeyMethod() {
  const method = buildAnthropicProvider().auth.find((entry) => entry.id === "api-key");
  if (!method) {
    throw new Error("Anthropic API-key setup is missing");
  }
  return method;
}

describe("Anthropic API-key workspace setup", () => {
  it("sends the entered provider workspace ID in the SDK request", async () => {
    const result = await apiKeyMethod().run(
      authContext(
        config,
        vi.fn(async () => ` ${workspaceId} `),
      ),
    );
    const next = applyProviderAuthConfigPatch(config, result.configPatch ?? {}, result);
    expect(config.models?.providers?.anthropic?.headers).toEqual({ "X-Route": "preserve" });
    const resolved = await resolveModelAsync("anthropic", modelId, undefined, next, {
      ...createEmptyAgentDiscoveryStores(),
      workspaceDir: path.resolve("agent-local-workspace"),
      skipAgentDiscovery: true,
      skipProviderRuntimeHooks: true,
      authProfileMode: "api_key",
    });
    if (!resolved.model) {
      throw new Error(resolved.error);
    }
    const requests: Request[] = [];
    const registry = createApiRegistry();
    registerBuiltInApiProviders(registry);
    const runtime = createNodeLlmRuntime(registry, {
      buildModelFetch: () => async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.headers.get("anthropic-workspace-id") !== workspaceId) {
          return Response.json(
            {
              type: "error",
              error: {
                type: "invalid_request_error",
                message:
                  "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace.",
              },
            },
            { status: 400 },
          );
        }
        return new Response(
          [
            {
              type: "message_start",
              message: { id: "msg_workspace", usage: { input_tokens: 1, output_tokens: 0 } },
            },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 1 },
            },
            { type: "message_stop" },
          ]
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    });
    const credential = result.profiles[0]?.credential;
    if (credential?.type !== "api_key") {
      throw new Error("Anthropic setup did not return an API key");
    }
    const response = await runtime
      .stream(
        resolved.model,
        {
          messages: [{ role: "user", content: "Reply with ok", timestamp: 1 }],
        },
        { apiKey: credential.key },
      )
      .result();
    expect([response.errorMessage, response.stopReason]).toEqual([undefined, "stop"]);
    expect(response.content).toMatchObject([{ type: "text", text: "ok" }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("anthropic-workspace-id")).toBe(workspaceId);
    expect(requests[0]?.headers.get("x-api-key")).toBe(apiKey);
    expect(requests[0]?.headers.get("x-route")).toBe("preserve");
  });

  it("leaves workspace-scoped keys without an explicit workspace override", async () => {
    const result = await apiKeyMethod().run(
      authContext(
        config,
        vi.fn(async () => "  "),
      ),
    );
    const next = applyProviderAuthConfigPatch(config, result.configPatch ?? {}, result);
    expect(next.models?.providers?.anthropic).toEqual(config.models?.providers?.anthropic);
    expect(result.profiles[0]?.credential).toMatchObject({ type: "api_key", key: apiKey });
  });

  const workspaceOverrides: Array<Pick<ModelProviderConfig, "headers" | "request">> = [
    { headers: { "Anthropic-Workspace-Id": workspaceId } },
    { request: { headers: { "anthropic-workspace-id": workspaceId } } },
    {
      headers: {
        "anthropic-workspace-id": {
          source: "env" as const,
          provider: "default",
          id: "ANTHROPIC_WORKSPACE_ID",
        },
      },
    },
  ];
  it.each(workspaceOverrides)(
    "preserves an existing provider workspace setting: %j",
    async (override) => {
      const configured: OpenClawConfig = {
        models: {
          providers: { anthropic: { ...config.models!.providers!.anthropic!, ...override } },
        },
      };
      const text = vi.fn(async () => {
        throw new Error("Existing workspace must not be replaced");
      });
      const result = await apiKeyMethod().run(authContext(configured, text));
      const next = applyProviderAuthConfigPatch(configured, result.configPatch ?? {}, result);
      expect(next.models?.providers?.anthropic).toEqual(configured.models?.providers?.anthropic);
      expect(text).not.toHaveBeenCalled();
    },
  );

  it("propagates cancellation before publishing a credential result", async () => {
    const cancelled = new Error("setup cancelled");
    await expect(
      apiKeyMethod().run(
        authContext(
          config,
          vi.fn(async () => {
            throw cancelled;
          }),
        ),
      ),
    ).rejects.toBe(cancelled);
  });
});
