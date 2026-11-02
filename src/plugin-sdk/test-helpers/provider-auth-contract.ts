// Provider auth contract helpers define reusable tests for provider auth implementations.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots, type AuthProfileStore } from "../agent-runtime.js";
import { createNonExitingRuntime } from "../runtime.js";
import type { WizardMultiSelectParams, WizardPrompter, WizardSelectParams } from "../setup.js";
import { registerProviders, requireProvider } from "./contracts-testkit.js";

type LoginOpenAICodexOAuth = (params: unknown) => Promise<{
  access: string;
  refresh: string;
  expires: number;
  email?: string;
} | null>;
type EnsureAuthProfileStore =
  typeof import("openclaw/plugin-sdk/provider-auth").ensureAuthProfileStore;
type ListProfilesForProvider =
  typeof import("openclaw/plugin-sdk/provider-auth").listProfilesForProvider;

const ensureAuthProfileStoreMock = vi.hoisted(() => vi.fn<EnsureAuthProfileStore>());
const listProfilesForProviderMock = vi.hoisted(() => vi.fn<ListProfilesForProvider>());

export type ProviderAuthContractPluginLoader = () => Promise<{
  default: Parameters<typeof registerProviders>[0];
}>;

type OpenAICodexProviderAuthContractOptions = {
  expectedCodexDefaultModel: string;
  loginOpenAICodexOAuthMock: ReturnType<typeof vi.fn<LoginOpenAICodexOAuth>>;
};

function buildPrompter(): WizardPrompter {
  return {
    intro: async () => {},
    outro: async () => {},
    note: async () => {},
    select: async <T>(params: WizardSelectParams<T>) => {
      const option = params.options[0];
      if (!option) {
        throw new Error("missing select option");
      }
      return option.value;
    },
    multiselect: async <T>(params: WizardMultiSelectParams<T>) => params.initialValues ?? [],
    text: async () => "",
    confirm: async () => false,
    progress: () => ({ update() {}, stop() {} }),
  };
}

function buildAuthContext() {
  return {
    config: {},
    prompter: buildPrompter(),
    runtime: createNonExitingRuntime(),
    isRemote: false,
    openUrl: async () => {},
    oauth: {
      createVpsAwareHandlers: vi.fn(),
    },
  };
}

async function loadProvider(load: ProviderAuthContractPluginLoader, id: string) {
  const { default: plugin } = await load();
  return requireProvider(await registerProviders(plugin), id);
}

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

async function withStdinTTY<T>(isTTY: boolean, run: () => Promise<T>): Promise<T> {
  const stdin = process.stdin;
  const previous = Object.getOwnPropertyDescriptor(stdin, "isTTY");
  Object.defineProperty(stdin, "isTTY", { configurable: true, enumerable: true, get: () => isTTY });
  try {
    return await run();
  } finally {
    if (previous) {
      Object.defineProperty(stdin, "isTTY", previous);
    } else {
      Reflect.deleteProperty(stdin, "isTTY");
    }
  }
}

function copilotProfile(token: string, storeSecret = false) {
  return {
    profileId: "github-copilot:github",
    credential: { type: "token", provider: "github-copilot", token },
    ...(storeSecret
      ? { secretStorage: { kind: "store", namePrefix: "GITHUB_COPILOT_TOKEN" } }
      : {}),
  };
}

function installSharedAuthProfileStoreHooks() {
  const state: { authStore: AuthProfileStore } = { authStore: { version: 1, profiles: {} } };
  beforeEach(() => {
    vi.doMock("openclaw/plugin-sdk/provider-auth", async () => {
      const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-auth")>(
        "openclaw/plugin-sdk/provider-auth",
      );
      return {
        ...actual,
        ensureAuthProfileStore: ensureAuthProfileStoreMock,
        listProfilesForProvider: listProfilesForProviderMock,
      };
    });
    state.authStore = { version: 1, profiles: {} };
    ensureAuthProfileStoreMock.mockReset();
    ensureAuthProfileStoreMock.mockImplementation(() => state.authStore);
    listProfilesForProviderMock.mockReset();
    listProfilesForProviderMock.mockImplementation((store, providerId) =>
      Object.entries(store.profiles)
        .filter(([, credential]) => credential?.provider === providerId)
        .map(([profileId]) => profileId),
    );
  });

  afterEach(() => {
    ensureAuthProfileStoreMock.mockReset();
    listProfilesForProviderMock.mockReset();
    clearRuntimeAuthProfileStoreSnapshots();
  });
  return state;
}

export function describeOpenAICodexProviderAuthContract(
  load: ProviderAuthContractPluginLoader,
  options: OpenAICodexProviderAuthContractOptions,
) {
  const { expectedCodexDefaultModel, loginOpenAICodexOAuthMock } = options;

  describe("openai provider ChatGPT auth contract", () => {
    installSharedAuthProfileStoreHooks();

    async function expectOAuthProfile(params: {
      access: string;
      profileId: string;
      email?: string;
      loginEmail?: string;
    }) {
      const provider = await loadProvider(load, "openai");
      const tokens = {
        refresh: "refresh-token",
        access: params.access,
        expires: 1_700_000_000_000,
      };
      loginOpenAICodexOAuthMock.mockResolvedValueOnce({ ...tokens, email: params.loginEmail });
      const result = await provider.auth[0]?.run(buildAuthContext() as never);
      expect(result).toEqual({
        profiles: [
          {
            profileId: params.profileId,
            credential: {
              type: "oauth",
              provider: "openai",
              ...tokens,
              ...(params.email ? { email: params.email } : {}),
            },
          },
        ],
        configPatch: { agents: { defaults: { models: { [expectedCodexDefaultModel]: {} } } } },
        defaultModel: expectedCodexDefaultModel,
        notes: undefined,
      });
    }

    const stableProfile = (identity: string) =>
      `openai:id-${Buffer.from(identity, "utf8").toString("base64url")}`;
    it.each([
      {
        name: "keeps OAuth auth results provider-owned",
        profileId: "openai:user@example.com",
        access: "access-token",
        email: "user@example.com",
        loginEmail: "user@example.com",
      },
      {
        name: "backfills OAuth email from the JWT profile claim",
        access: createJwt({ "https://api.openai.com/profile": { email: "jwt-user@example.com" } }),
        profileId: "openai:jwt-user@example.com",
        email: "jwt-user@example.com",
      },
      {
        name: "uses a stable fallback id when JWT email is missing",
        access: createJwt({
          "https://api.openai.com/auth": { chatgpt_account_user_id: "user-123__acct-456" },
        }),
        profileId: stableProfile("user-123__acct-456"),
      },
      {
        name: "uses iss and sub to build a stable fallback id when auth claims are missing",
        access: createJwt({ iss: "https://accounts.openai.com", sub: "user-abc" }),
        profileId: stableProfile("https://accounts.openai.com|user-abc"),
      },
      {
        name: "uses sub alone to build a stable fallback id when iss is missing",
        access: createJwt({ sub: "user-abc" }),
        profileId: stableProfile("user-abc"),
      },
      {
        name: "falls back to the default profile when JWT parsing yields no identity",
        access: "not-a-jwt-token",
        profileId: "openai:default",
      },
    ])("$name", expectOAuthProfile);

    it("surfaces OAuth failures instead of silently succeeding with no profiles", async () => {
      const provider = await loadProvider(load, "openai");
      loginOpenAICodexOAuthMock.mockRejectedValueOnce(new Error("oauth failed"));

      await expect(provider.auth[0]?.run(buildAuthContext() as never)).rejects.toThrow(
        "oauth failed",
      );
    });
  });
}

export function describeGithubCopilotProviderAuthContract(
  load: ProviderAuthContractPluginLoader,
  defaultModel: string,
) {
  describe("github-copilot provider auth contract", () => {
    const state = installSharedAuthProfileStoreHooks();
    const getProvider = () => loadProvider(load, "github-copilot");

    async function runDeviceAuthWithFakeTimers<T>(
      run: () => T | Promise<T>,
      openUrl: (url: string) => Promise<void>,
    ): Promise<T> {
      vi.useFakeTimers();
      try {
        const deviceCodeShown = new Promise<void>((resolve) => {
          vi.mocked(openUrl).mockImplementation(async () => resolve());
        });
        const pending = Promise.resolve(run());
        const openedBeforeCompletion = await Promise.race([
          deviceCodeShown.then(() => true),
          pending.then(() => false),
        ]);
        expect(openedBeforeCompletion).toBe(true);
        // Browser handoff follows the profile, device-code, and prompt work.
        await vi.advanceTimersByTimeAsync(1_000);
        return await pending;
      } finally {
        vi.useRealTimers();
      }
    }

    function resolveFetchTarget(input: unknown): string {
      return typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input instanceof Request
            ? input.url
            : String(input);
    }

    it("keeps existing device auth results provider-owned", async () => {
      const provider = await getProvider();
      stubGitHubDeviceFlowFetch();
      state.authStore.profiles["github-copilot:github"] = {
        type: "token",
        provider: "github-copilot",
        token: "github-device-token",
      };

      await withStdinTTY(true, async () => {
        const result = await provider.auth[0]?.run({
          ...buildAuthContext(),
          existingProfiles: [
            {
              profileId: "github-copilot:github",
              credential: state.authStore.profiles["github-copilot:github"],
            },
          ],
        } as never);
        expect(result).toEqual({
          profiles: [copilotProfile("github-device-token")],
          defaultModel,
        });
      });
    });

    function stubGitHubDeviceFlowFetch(
      outcome?: { accessToken: string } | { error: "access_denied" | "expired_token" },
    ) {
      const api = "https://api.individual.githubcopilot.com";
      const responses = new Map<string, unknown>([
        ["https://api.github.com/copilot_internal/user", { endpoints: { api } }],
        [
          `${api}/models`,
          {
            data: [
              {
                id: defaultModel.replace("github-copilot/", ""),
                name: "Contract starter model",
                model_picker_enabled: true,
                model_picker_category: "versatile",
                policy: { state: "enabled" },
                capabilities: {
                  type: "chat",
                  limits: { max_context_window_tokens: 200_000, max_output_tokens: 64_000 },
                  supports: { streaming: true, tool_calls: true },
                },
              },
            ],
          },
        ],
      ]);
      if (outcome) {
        responses.set("https://github.com/login/device/code", {
          device_code: "device-code-stub",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 0,
        });
        responses.set(
          "https://github.com/login/oauth/access_token",
          "accessToken" in outcome
            ? { access_token: outcome.accessToken, token_type: "bearer" }
            : { error: outcome.error },
        );
      }
      const fetchMock = vi.fn(async (input: unknown) => {
        const target = resolveFetchTarget(input);
        if (!responses.has(target)) {
          throw new Error(`unexpected fetch in github-copilot device flow stub: ${target}`);
        }
        return Response.json(responses.get(target));
      });
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    function buildSpyAuthContext() {
      const ctx = {
        ...buildAuthContext(),
        openUrl: vi.fn(async (_url: string) => {}),
      };
      ctx.prompter.note = vi.fn(async () => {});
      return ctx;
    }

    async function runDeviceFlow(outcome: Parameters<typeof stubGitHubDeviceFlowFetch>[0]) {
      const provider = await getProvider();
      stubGitHubDeviceFlowFetch(outcome);
      const ctx = buildSpyAuthContext();
      const result = await runDeviceAuthWithFakeTimers(
        () => provider.auth[0]?.run(ctx as never),
        ctx.openUrl,
      );
      return { result, ctx };
    }

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it("keeps device auth results provider-owned", async () => {
      const { result, ctx } = await runDeviceFlow({ accessToken: "github-device-token" });

      expect(result).toEqual({
        profiles: [copilotProfile("github-device-token", true)],
        defaultModel,
      });
      expect(ctx.openUrl).toHaveBeenCalledWith("https://github.com/login/device");
      const noteCalls = (ctx.prompter.note as ReturnType<typeof vi.fn>).mock.calls;
      const codeNote = noteCalls.find(
        ([msg]) => typeof msg === "string" && msg.includes("ABCD-1234"),
      );
      expect(codeNote).toBeDefined();
      expect(codeNote?.[0]).toContain("https://github.com/login/device");
    });

    it("supports non-interactive (GUI/RPC) auth contexts without a TTY", async () => {
      await withStdinTTY(false, async () => {
        const { result } = await runDeviceFlow({ accessToken: "rpc-client-token" });
        expect(result?.profiles).toEqual([copilotProfile("rpc-client-token", true)]);
      });
    });

    it.each([
      ["access_denied", "cancel"],
      ["expired_token", "expired"],
    ] as const)("returns no profiles and notes %s", async (error, note) => {
      const { result, ctx } = await runDeviceFlow({ error });
      expect(result).toEqual({ profiles: [] });
      const noteCalls = (ctx.prompter.note as ReturnType<typeof vi.fn>).mock.calls;
      expect(
        noteCalls.some(([msg]) => typeof msg === "string" && msg.toLowerCase().includes(note)),
      ).toBe(true);
    });
  });
}
