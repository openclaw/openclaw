import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadAuthProfileStore } from "../../agents/auth-profiles/store-runtime.js";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import { handleCommands } from "../../auto-reply/reply/commands-core.js";
import { buildCommandTestParams } from "../../auto-reply/reply/commands.test-harness.js";
import type { OpenClawConfig } from "../../config/types.js";
import * as persistence from "../../plugins/provider-auth-persistence.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createPluginRegistryOwner, setActivePluginRegistry } from "../../plugins/runtime.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerProviderPlugin } from "../../test-utils/plugin-registration.js";

const discovery = vi.hoisted(() => {
  const providers: ProviderPlugin[] = [];
  return { providers };
});
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
describe("[commands] registered /login minimax-global-oauth", () => {
  it.each(["after presentation", "during pending response", "during browser failure", "allowed"])(
    "%s preserves current login authority and saves only an allowed completion once",
    async (scenario) => {
      await withOpenClawTestState(
        { label: "minimax-chat-login", applyEnv: true },
        async (state) => {
          const registry = createEmptyPluginRegistry();
          setActivePluginRegistry(registry);
          const registryOwner = createPluginRegistryOwner(registry, state.workspaceDir);
          const save = vi.spyOn(persistence, "persistProviderAuthProfilesAfterLogin");
          const firstPoll = createDeferredCore();
          const pendingResponse = createDeferredCore();
          const abort = new AbortController();
          const messages: string[] = [];
          const tokenRequests: boolean[] = [];
          let tokensIssued = 0;
          let browserFailures = 0;
          let revoked = false;
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
          let current = initial;
          const revoke = () => {
            current = {
              ...initial,
              commands: { ...initial.commands, ownerAllowFrom: ["replacement"] },
            };
            revoked = true;
            expect(abort.signal.aborted).toBe(false);
            expect(
              resolveCommandAuthorization({
                cfg: current,
                ctx: { Provider: "slack", ChatType: "direct", SenderId: "owner" },
                commandAuthorized: true,
              }),
            ).toMatchObject({ senderIsOwner: false, isAuthorizedSender: false });
          };
          const dispatch = (command: string, cfg = current) => {
            const params = buildCommandTestParams(
              command,
              cfg,
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
              getProviderLoginConfig: () => current,
              onBlockReply: async ({ text }) => {
                messages.push(text ?? "");
                if (text?.includes("https://account.minimax.io/verify")) {
                  if (scenario === "during browser failure") {
                    revoke();
                    browserFailures += 1;
                    throw new Error("Browser presentation failed");
                  }
                  if (scenario === "allowed" && text.startsWith("Sign in with MiniMax")) {
                    browserFailures += 1;
                    throw new Error("Browser presentation failed");
                  }
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
            const url =
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
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
            tokenRequests.push(revoked);
            firstPoll.resolve();
            if (tokenRequests.length === 1 && scenario !== "allowed") {
              if (scenario === "during pending response") {
                await pendingResponse.promise;
              }
              return Response.json({ status: "pending" });
            }
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
            if (scenario === "after presentation" || scenario === "during pending response") {
              await Promise.race([
                firstPoll.promise,
                login.then(() => {
                  throw new Error("Registered /login ended before its first token request");
                }),
              ]);
              expect(messages.some((text) => text.includes("LOGIN-CODE"))).toBe(true);
              if (scenario === "after presentation") {
                // Let the immediate pending response drain before changing policy during poll sleep.
                await nextEventLoopTurn();
              }
              revoke();
              pendingResponse.resolve();
            }
            const result = await login;
            expect(browserFailures).toBe(
              scenario === "during browser failure" || scenario === "allowed" ? 1 : 0,
            );
            expect(result.shouldContinue).toBe(false);
            expect(fetchMock.mock.calls[0]?.[0]).toBe(
              "https://account.minimax.io/oauth2/device/code",
            );
            const profiles = Object.values(loadAuthProfileStore().profiles).filter(
              (credential) => credential.provider === "minimax-portal",
            );
            if (scenario === "allowed") {
              expect(messages.some((text) => text.includes("LOGIN-CODE"))).toBe(true);
              expect(tokenRequests).toEqual([false]);
              expect(tokensIssued).toBe(1);
              expect(save).toHaveBeenCalledOnce();
              expect(profiles).toEqual([expect.objectContaining({ type: "oauth" })]);
              expect(result.reply?.text).toMatch(/credentials are saved|login complete/);
            } else {
              expect(revoked).toBe(true);
              expect((await dispatch("/login")).reply?.text).toContain("Only an OpenClaw owner");
              expect(tokenRequests).toEqual(scenario === "during browser failure" ? [] : [false]);
              expect(tokensIssued).toBe(0);
              expect(save).not.toHaveBeenCalled();
              expect(profiles).toEqual([]);
              expect(result.reply?.text).toContain("MiniMax login did not complete");
            }
          } finally {
            pendingResponse.resolve();
            abort.abort();
            await Promise.allSettled(login ? [login] : []);
            await registryOwner.close();
          }
        },
      );
    },
  );
});
