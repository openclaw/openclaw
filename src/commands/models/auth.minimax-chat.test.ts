import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { loadAuthProfileStoreForRuntimeAsync } from "../../agents/auth-profiles/store-runtime.js";
import { handleCommands } from "../../auto-reply/reply/commands-core.js";
import { buildCommandTestParams } from "../../auto-reply/reply/commands.test-harness.js";
import type { OpenClawConfig } from "../../config/types.js";
import * as persistence from "../../plugins/provider-auth-persistence.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createPluginRegistryOwner, setActivePluginRegistry } from "../../plugins/runtime.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerProviderPlugin } from "../../test-utils/plugin-registration.js";

const discovery = vi.hoisted<{ providers: ProviderPlugin[] }>(() => ({ providers: [] }));
vi.mock("../../plugins/providers.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/providers.runtime.js")>()),
  resolvePluginProvidersCore: () => discovery.providers,
}));
vi.mock("../../plugins/setup-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/setup-registry.js")>()),
  resolvePluginSetupRegistry: () => ({ providers: [] }),
  resolvePluginSetupProviderCore: () => undefined,
}));

beforeAll(async () => {
  const { default: minimaxPlugin } = await loadBundledPluginFacade<{
    default: Parameters<typeof registerProviderPlugin>[0]["plugin"];
  }>({ pluginId: "minimax", artifactBasename: "index.js" });
  discovery.providers = (
    await registerProviderPlugin({ plugin: minimaxPlugin, id: "minimax", name: "MiniMax" })
  ).providers;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// The commands project uses forks so these regressions exercise real credential persistence.
// Authority is checked once when /login starts (root AGENTS.md); this proves one save per completion.
it("saves an allowed chat login completion once", () =>
  withOpenClawTestState({ label: "minimax-chat-login", applyEnv: true }, async (state) => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);
    const registryOwner = createPluginRegistryOwner(registry, state.workspaceDir);
    const save = vi.spyOn(persistence, "persistProviderAuthProfilesAfterLogin");
    const abort = new AbortController();
    const messages: string[] = [];
    const tokenRequests: boolean[] = [];
    let tokensIssued = 0;
    let browserFailures = 0;
    const initial: OpenClawConfig = {
      commands: { text: true, ownerAllowFrom: ["owner"] },
      channels: { slack: { allowFrom: ["owner"] } },
      agents: { defaults: { workspace: state.workspaceDir } },
      plugins: {
        allow: ["minimax"],
        entries: { minimax: { enabled: true } },
        slots: { memory: "none" },
      },
    };
    const dispatch = (command: string) => {
      const params = buildCommandTestParams(
        command,
        initial,
        {
          Provider: "slack",
          Surface: "slack",
          OriginatingChannel: "slack",
          OriginatingTo: "direct:owner",
          To: "direct:owner",
          From: "slack:owner",
          SenderId: "owner",
          AccountId: "default",
          ChatType: "direct",
        },
        { workspaceDir: state.workspaceDir },
      );
      params.agentDir = state.agentDir();
      params.sessionKey = "agent:main:slack:direct:owner";
      params.provider = "minimax-portal";
      params.model = "MiniMax-M2.7";
      params.opts = {
        abortSignal: abort.signal,
        getProviderLoginConfig: () => initial,
        onBlockReply: async ({ text }) => {
          messages.push(text ?? "");
          // A failed browser-button delivery falls back to the device code.
          if (
            text?.includes("https://account.minimax.io/verify") &&
            text.startsWith("Sign in with MiniMax")
          ) {
            browserFailures += 1;
            throw new Error("Browser presentation failed");
          }
        },
      };
      return handleCommands({
        ...params,
        resolveModelLevels: async () => ({
          resolvedThinkLevel: params.resolvedThinkLevel,
          resolvedReasoningLevel: params.resolvedReasoningLevel,
        }),
      });
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://account.minimax.io/oauth2/device/code") {
        if (typeof init?.body !== "string") {
          throw new Error("Expected a form-encoded login request body");
        }
        return Response.json({
          user_code: "LOGIN-CODE",
          verification_uri: "https://account.minimax.io/verify",
          expired_in: Date.now() + 60_000,
          interval: 2_000,
          state: new URLSearchParams(init.body).get("state"),
        });
      }
      if (url !== "https://account.minimax.io/oauth2/token") {
        throw new Error(`Unexpected login request: ${url}`);
      }
      tokenRequests.push(true);
      tokensIssued += 1;
      return Response.json({
        status: "success",
        access_token: "synthetic-access",
        refresh_token: "synthetic-refresh",
        expired_in: 3_600,
        resource_url: "https://api.minimax.io/anthropic",
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    let login: ReturnType<typeof dispatch> | undefined;
    try {
      await state.writeConfig(initial);
      login = dispatch("/login minimax-global-oauth");
      const result = await login;
      expect(result.shouldContinue).toBe(false);
      const profiles = Object.values(
        (
          await loadAuthProfileStoreForRuntimeAsync(undefined, {
            readOnly: true,
            allowKeychainPrompt: false,
          })
        ).profiles,
      ).filter((credential) => credential.provider === "minimax-portal");
      expect({ browserFailures, tokenRequests, tokensIssued, profiles }).toEqual({
        browserFailures: 1,
        tokenRequests: [true],
        tokensIssued: 1,
        profiles: [expect.objectContaining({ type: "oauth" })],
      });
      expect(save).toHaveBeenCalledOnce();
      expect(result.reply?.text).toMatch(/credentials are saved|login complete/);
      expect(messages.some((text) => text.includes("LOGIN-CODE"))).toBe(true);
    } finally {
      abort.abort();
      await Promise.allSettled(login ? [login] : []);
      await registryOwner.close();
    }
  }));
