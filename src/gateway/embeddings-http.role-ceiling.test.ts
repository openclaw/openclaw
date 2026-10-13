// Operator-role agent ceiling for session-selected embedding owners.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createConfigIO, resetConfigRuntimeState } from "../config/config.js";
import type { EmbeddingInput } from "../plugins/embedding-providers.js";
import {
  clearEmbeddingProviders,
  registerEmbeddingProvider,
} from "../plugins/embedding-providers.js";
import type { MemoryEmbeddingProviderAdapter } from "../plugins/memory-embedding-providers.js";
import { createPluginRegistry } from "../plugins/registry.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withEnvAsync } from "../test-utils/env.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { startOpenAiCompatGatewayServer } from "./openai-compatible-http.test-helpers.js";
import {
  installGatewayTestHooks,
  resetTestPluginRegistry,
  setTestPluginRegistry,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const trustedProxyAuth = {
  mode: "trusted-proxy" as const,
  trustedProxy: {
    userHeader: "x-forwarded-user",
    requiredHeaders: ["x-forwarded-proto"],
    allowLoopback: true,
  },
};

describe("OpenAI embeddings operator role ceiling", () => {
  it("rejects a session-selected agent outside the operator role before provider work", async () => {
    await withEnvAsync(
      { OPENCLAW_GATEWAY_TOKEN: undefined, OPENCLAW_GATEWAY_PASSWORD: undefined },
      async () => {
        const createEmbeddingProvider = vi.fn(
          async (options: { provider: string; model: string }) => ({
            provider: {
              id: options.provider,
              model: options.model,
              embed: async () => [0.1, 0.2],
              embedBatch: async (inputs: EmbeddingInput[]) => inputs.map(() => [0.1, 0.2]),
            },
          }),
        );
        const adapter: MemoryEmbeddingProviderAdapter = {
          id: "openai",
          defaultModel: "text-embedding-3-small",
          transport: "remote",
          autoSelectPriority: 20,
          allowExplicitWhenConfiguredAuto: true,
          create: async (options) =>
            await createEmbeddingProvider({
              provider: options.provider ?? "openai",
              model: options.model,
            }),
        };
        const previousAuth = testState.gatewayAuth;
        const previousAgents = testState.agentsConfig;
        testState.gatewayAuth = trustedProxyAuth;
        testState.agentsConfig = {
          ownership: "explicit",
          entries: {
            alpha: { memory: { search: { provider: "openai", model: "alpha-embed" } } },
            beta: { memory: { search: { provider: "openai", model: "beta-embed" } } },
          },
        };
        const builder = createPluginRegistry({
          logger: { info() {}, warn() {}, error() {}, debug() {} },
          runtime: {} as PluginRuntime,
          activateGlobalSideEffects: true,
        });
        setTestPluginRegistry(builder.registry);
        registerEmbeddingProvider(adapter);
        let server: Awaited<ReturnType<typeof startOpenAiCompatGatewayServer>> | undefined;
        try {
          const configPath = createConfigIO().configPath;
          await fs.mkdir(path.dirname(configPath), { recursive: true });
          await fs.writeFile(
            configPath,
            JSON.stringify({
              gateway: {
                auth: trustedProxyAuth,
                trustedProxies: ["127.0.0.1"],
                roles: {
                  default: "alpha-only",
                  definitions: {
                    "alpha-only": {
                      agents: ["alpha"],
                      scopes: ["operator.write"],
                      sessions: { others: "none" },
                    },
                    "beta-operator": {
                      agents: ["beta"],
                      scopes: ["operator.write"],
                      sessions: { others: "none" },
                    },
                  },
                },
              },
            }),
          );
          resetConfigRuntimeState();
          const { startGatewayServer } = await import("./server.js");
          const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
          server = await startOpenAiCompatGatewayServer({
            startGatewayServer,
            port: portClaim,
            auth: trustedProxyAuth,
            openAiChatCompletionsEnabled: true,
          });
          setUserProfileRole(
            ensureProfileForEmail("alpha-only@embed-role.example.test").id,
            "alpha-only",
          );
          setUserProfileRole(
            ensureProfileForEmail("beta-operator@embed-role.example.test").id,
            "beta-operator",
          );
          const post = (user: string) =>
            fetch(`http://127.0.0.1:${portClaim.port}/v1/embeddings`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-forwarded-for": "198.51.100.42",
                "x-forwarded-proto": "https",
                "x-forwarded-user": user,
                "x-openclaw-scopes": "operator.write",
                "x-openclaw-session-key": "agent:beta:embed-role",
              },
              body: JSON.stringify({ model: "openclaw", input: "OPENCLAW_E2E_EMBED_ROLE" }),
            });

          const denied = await post("alpha-only@embed-role.example.test");
          expect(denied.status).toBe(403);
          expect(await denied.json()).toMatchObject({
            error: {
              type: "forbidden",
              message: expect.stringContaining('cannot create sessions for agent "beta"'),
            },
          });
          expect(createEmbeddingProvider).not.toHaveBeenCalled();

          const allowed = await post("beta-operator@embed-role.example.test");
          expect(allowed.status).toBe(200);
          expect(createEmbeddingProvider).toHaveBeenCalledOnce();
          expect(createEmbeddingProvider.mock.calls[0]?.[0]?.model).toBe("beta-embed");
        } finally {
          try {
            await server?.close({ reason: "embeddings role agent ceiling test done" });
          } finally {
            testState.gatewayAuth = previousAuth;
            testState.agentsConfig = previousAgents;
            clearEmbeddingProviders();
            resetTestPluginRegistry();
            resetConfigRuntimeState();
          }
        }
      },
    );
  });
});
