import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { ConfigWriteOptions } from "../../config/io.js";
import { createEmptyPluginSetupRegistry } from "../../plugins/setup-registry.test-support.js";
import type {
  ProviderAuthProfile,
  ProviderAuthResult,
  ProviderPlugin,
} from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import { ProviderAuthConfigApplyError } from "../../shared/provider-auth-result.js";
import { expectNoCalls } from "../../test-utils/mock-call-assertions.js";
import { registerModelsAuthAuthorityTests } from "./auth-authority.test-support.js";

type AuthRunCall = { signal?: AbortSignal };
type ResolvePluginProvidersCall = { providerRefs?: string[] };
type PersistProviderAuthCall = Partial<Pick<ProviderAuthResult, "profiles">>;

const mocks = vi.hoisted(() => ({
  clackCancel: vi.fn(),
  clackConfirm: vi.fn(),
  clackPassword: vi.fn(),
  clackSelect: vi.fn(),
  clackText: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  resolveAgentDir: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentWorkspaceDir: vi.fn(),
  isCliProvider: vi.fn(),
  upsertAuthProfile: vi.fn(),
  upsertAuthProfileWithLock: vi.fn(),
  persistProviderAuthProfilesAfterLogin: vi.fn(),
  removeProviderAuthProfilesWithLock: vi.fn(),
  loadAuthProfileStoreWithoutExternalProfiles: vi.fn(),
  resolvePluginProvidersCore: vi.fn(),
  createClackPrompter: vi.fn(),
  loadValidConfigSnapshotOrThrow: vi.fn(),
  updateConfig: vi.fn(),
  logConfigUpdated: vi.fn(),
  openUrl: vi.fn(),
  isRemoteEnvironment: vi.fn(() => false),
  validateAnthropicSetupToken: vi.fn<() => string | undefined>(() => undefined),
  promoteAuthProfileInOrder: vi.fn(),
  tryImportProviderCredential: vi.fn(),
  callGateway: vi.fn(),
  isImplicitLocalGatewayTarget: vi.fn(() => Promise.resolve(true)),
  resolvePluginSetupProviderCore: vi.fn(),
  resolvePluginSetupRegistry: vi.fn(),
}));

vi.mock("../../agents/auth-profiles/profiles.js", () => ({
  promoteAuthProfileInOrder: mocks.promoteAuthProfileInOrder,
  removeProviderAuthProfilesWithLock: mocks.removeProviderAuthProfilesWithLock,
  upsertAuthProfile: mocks.upsertAuthProfile,
  upsertAuthProfileWithLock: mocks.upsertAuthProfileWithLock,
  upsertAuthProfileWithLockOrThrow: mocks.upsertAuthProfileWithLock,
}));

vi.mock("../../agents/auth-profiles/store-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/auth-profiles/store-runtime.js")>()),
  loadAuthProfileStoreWithoutExternalProfilesAsync: async (agentDir?: string) =>
    mocks.loadAuthProfileStoreWithoutExternalProfiles(agentDir),
}));

vi.mock("../../plugins/provider-auth-persistence.js", () => ({
  persistProviderAuthProfilesAfterLogin: mocks.persistProviderAuthProfilesAfterLogin,
}));

vi.mock("./auth-credential-import.js", () => ({
  tryImportProviderCredential: mocks.tryImportProviderCredential,
}));

vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  cancel: mocks.clackCancel,
  confirm: mocks.clackConfirm,
  password: mocks.clackPassword,
  select: mocks.clackSelect,
  text: mocks.clackText,
}));

vi.mock("../../agents/agent-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/agent-scope.js")>();
  return {
    ...actual,
    resolveDefaultAgentId: mocks.resolveDefaultAgentId,
    resolveAgentDir: mocks.resolveAgentDir,
    resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  };
});

vi.mock("../../agents/workspace.js", () => ({
  resolveDefaultAgentWorkspaceDir: mocks.resolveDefaultAgentWorkspaceDir,
}));

// mock-isolation: Provider classification is controlled by each auth scenario.
vi.mock("../../agents/model-selection-cli.js", () => ({ isCliProvider: mocks.isCliProvider }));

vi.mock("../../plugins/providers.runtime.js", () => ({
  resolvePluginProvidersCore: mocks.resolvePluginProvidersCore,
}));

vi.mock("../../plugins/setup-registry.js", () => ({
  resolvePluginSetupProviderCore: mocks.resolvePluginSetupProviderCore,
  resolvePluginSetupRegistry: mocks.resolvePluginSetupRegistry,
}));

vi.mock("../../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));

vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    loadValidConfigSnapshotOrThrow: mocks.loadValidConfigSnapshotOrThrow,
    updateConfig: mocks.updateConfig,
  };
});

vi.mock("../../plugins/install-record-commit.js", () => ({
  transformConfigWithPendingPluginInstalls: async (params: {
    transform: (
      current: OpenClawConfig,
      context: { snapshot: { valid: boolean } },
    ) => { nextConfig: OpenClawConfig };
    writeOptions?: ConfigWriteOptions;
  }) => {
    const next = await mocks.updateConfig(
      (current: OpenClawConfig) =>
        params.transform(current, { snapshot: { valid: true } }).nextConfig,
      undefined,
      params.writeOptions?.beforeCommit,
      params.writeOptions,
    );
    return { nextConfig: next, result: next };
  },
}));

// mock-isolation: Observe config notices without initializing the real logger.
vi.mock("../../config/logging.js", () => ({ logConfigUpdated: mocks.logConfigUpdated }));

// mock-isolation: Auth scenarios must not open an operator browser.
vi.mock("../../infra/browser-open.js", () => ({ openUrl: mocks.openUrl }));

// mock-isolation: The fixture selects local versus remote auth behavior explicitly.
vi.mock("../../infra/remote-env.js", () => ({ isRemoteEnvironment: mocks.isRemoteEnvironment }));

vi.mock("../../gateway/call.js", async () => {
  const requestErrors = await import("../../../packages/gateway-client/src/request-error.js");
  return {
    callGateway: mocks.callGateway,
    GatewayLocalBackendSharedAuthUnavailableError: class extends Error {},
    isGatewayClientRequestError: (error: unknown) =>
      error instanceof requestErrors.GatewayClientRequestError,
    isImplicitLocalGatewayTarget: mocks.isImplicitLocalGatewayTarget,
  };
});

vi.mock("../auth-token.js", () => ({
  validateAnthropicSetupToken: mocks.validateAnthropicSetupToken,
}));

const {
  modelsAuthAddCommand,
  modelsAuthLoginCommand,
  modelsAuthPasteApiKeyCommand,
  modelsAuthPasteTokenCommand,
  modelsAuthSetupTokenCommand,
  runModelsAuthLoginFlowCore,
} = await import("./auth.js");

function createRuntime(): RuntimeEnv {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

function usePrompter(select: Mock = vi.fn(), note: Mock = vi.fn(async () => {})) {
  const prompter = { note, select };
  mocks.createClackPrompter.mockReturnValue(prompter);
  return prompter;
}

function overrideStdin(key: PropertyKey, descriptor: PropertyDescriptor) {
  const previous = Object.getOwnPropertyDescriptor(process.stdin, key);
  Object.defineProperty(process.stdin, key, { configurable: true, ...descriptor });
  return () => {
    if (previous) {
      Object.defineProperty(process.stdin, key, previous);
    } else {
      Reflect.deleteProperty(process.stdin, key);
    }
  };
}

function withPipedStdin(input: string | Buffer) {
  const restoreTTY = overrideStdin("isTTY", { enumerable: true, get: () => false });
  const restoreIterator = overrideStdin(Symbol.asyncIterator, {
    async *value() {
      yield input;
    },
  });
  return () => {
    restoreIterator();
    restoreTTY();
  };
}

function createProvider(
  id: string,
  label: string,
  auth: ProviderPlugin["auth"] = [
    { id: "oauth", label: "OAuth", kind: "oauth", run: runProviderAuth },
  ],
): ProviderPlugin {
  return { id, label, auth };
}

function useProvider(id: string, label: string, auth?: ProviderPlugin["auth"]) {
  mocks.resolvePluginProvidersCore.mockReturnValue([createProvider(id, label, auth)]);
}

function createOpenAISetupProvider(
  runOauthAuth: ProviderPlugin["auth"][number]["run"],
  runApiKeyAuth: ProviderPlugin["auth"][number]["run"],
): ProviderPlugin {
  return createProvider("openai", "OpenAI", [
    { id: "oauth", label: "ChatGPT Login", kind: "oauth", run: runOauthAuth },
    { id: "api-key", label: "OpenAI API Key", kind: "api_key", run: runApiKeyAuth },
  ]);
}

function oauthProfile(
  profileId = "openai:user@example.com",
  credential: Partial<Extract<ProviderAuthProfile["credential"], { type: "oauth" }>> = {},
): ProviderAuthProfile {
  return {
    profileId,
    credential: {
      type: "oauth",
      provider: "openai",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      email: "user@example.com",
      ...credential,
    },
  };
}

function tokenProfile(
  profileId: string,
  provider = "openai",
  token = "fixture-token",
): ProviderAuthProfile {
  return { profileId, credential: { type: "token", provider, token } };
}

function claudeDefaults(provider: string) {
  const primary = `${provider}/claude-sonnet-4-6`;
  const fallback = `${provider}/claude-opus-4-6`;
  return {
    model: { primary, fallbacks: [fallback, "openai/gpt-5.2"] },
    models: {
      [primary]: { alias: "Sonnet" },
      [fallback]: { alias: "Opus" },
      "openai/gpt-5.2": {},
    },
  };
}

let runtime: RuntimeEnv;
let restoreStdin: (() => void) | null = null;
let currentConfig: OpenClawConfig;
let lastUpdatedConfig: OpenClawConfig | null;
let runProviderAuth: Mock<ProviderPlugin["auth"][number]["run"]>;

beforeEach(() => {
  vi.clearAllMocks();
  runtime = createRuntime();
  restoreStdin = overrideStdin("isTTY", { enumerable: true, get: () => true });
  currentConfig = {};
  lastUpdatedConfig = null;
  mocks.clackCancel.mockReset();
  mocks.clackConfirm.mockReset();
  mocks.clackPassword.mockReset();
  mocks.clackSelect.mockReset();
  mocks.clackText.mockReset();
  mocks.validateAnthropicSetupToken.mockReset().mockReturnValue(undefined);
  mocks.upsertAuthProfileWithLock.mockReset().mockResolvedValue({ version: 1, profiles: {} });
  mocks.persistProviderAuthProfilesAfterLogin
    .mockReset()
    .mockImplementation(async (params: PersistProviderAuthCall) => params.profiles ?? []);
  mocks.promoteAuthProfileInOrder.mockReset().mockResolvedValue({
    ok: true,
    value: { version: 1, profiles: {} },
  });
  mocks.tryImportProviderCredential.mockReset().mockResolvedValue(undefined);
  mocks.removeProviderAuthProfilesWithLock
    .mockReset()
    .mockResolvedValue({ version: 1, profiles: {} });
  mocks.loadAuthProfileStoreWithoutExternalProfiles.mockReset().mockReturnValue({
    version: 1,
    profiles: {},
  });

  mocks.resolveDefaultAgentId.mockReturnValue("main");
  mocks.resolveAgentDir.mockReturnValue("/tmp/openclaw/agents/main");
  mocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/openclaw/workspace");
  mocks.resolveDefaultAgentWorkspaceDir.mockReturnValue("/tmp/openclaw/workspace");
  mocks.isRemoteEnvironment.mockReturnValue(false);
  mocks.isCliProvider.mockReturnValue(false);
  mocks.resolvePluginSetupProviderCore.mockReturnValue(undefined);
  mocks.resolvePluginSetupRegistry.mockReturnValue(createEmptyPluginSetupRegistry());
  mocks.loadValidConfigSnapshotOrThrow.mockImplementation(async () => ({
    sourceConfig: structuredClone(currentConfig),
    runtimeConfig: structuredClone(currentConfig),
  }));
  mocks.updateConfig.mockImplementation(
    async (
      mutator: (cfg: OpenClawConfig) => OpenClawConfig | Promise<OpenClawConfig>,
      _selectModelRefs: unknown,
      beforeCommit?: ConfigWriteOptions["beforeCommit"],
      writeOptions?: ConfigWriteOptions,
    ) => {
      const nextConfig = await mutator(currentConfig);
      await beforeCommit?.();
      writeOptions?.assertCurrent?.();
      lastUpdatedConfig = nextConfig;
      currentConfig = lastUpdatedConfig;
      return lastUpdatedConfig;
    },
  );
  usePrompter(vi.fn().mockResolvedValue("keep"));
  runProviderAuth = vi.fn<ProviderPlugin["auth"][number]["run"]>().mockResolvedValue({
    profiles: [oauthProfile()],
    defaultModel: "openai/gpt-5.5",
  });
  useProvider("openai", "OpenAI Codex");
  mocks.callGateway.mockReset().mockResolvedValue({ refreshed: true });
});

afterEach(() => {
  restoreStdin?.();
  restoreStdin = null;
});

function loginCommand(
  options: Parameters<typeof modelsAuthLoginCommand>[0] = { provider: "openai" },
) {
  return modelsAuthLoginCommand(options, runtime);
}

function loginFlow(options: Partial<Parameters<typeof runModelsAuthLoginFlowCore>[0]> = {}) {
  return runModelsAuthLoginFlowCore({
    provider: "openai",
    runtime,
    prompter: mocks.createClackPrompter(),
    ...options,
  });
}

registerModelsAuthAuthorityTests({
  mocks,
  loginFlow,
  setProviderAuthResult: (result) => runProviderAuth.mockResolvedValueOnce(result),
});

function pipeInput(input: string | Buffer) {
  restoreStdin?.();
  restoreStdin = withPipedStdin(input);
}

function useCoderAgentConfig() {
  currentConfig = {
    agents: {
      entries: { main: {}, coder: { workspace: "/tmp/openclaw/workspaces/coder" } },
    },
  };
  mocks.resolveAgentDir.mockImplementation((_cfg: OpenClawConfig, agentId: string) =>
    agentId === "coder" ? "/tmp/openclaw/agents/coder" : "/tmp/openclaw/agents/main",
  );
  mocks.resolveAgentWorkspaceDir.mockImplementation((_cfg: OpenClawConfig, agentId: string) =>
    agentId === "coder" ? "/tmp/openclaw/workspaces/coder" : "/tmp/openclaw/workspace",
  );
  return currentConfig;
}

function useTokenProvider(configPatch?: OpenClawConfig) {
  const runTokenAuth = vi.fn().mockResolvedValue({
    ...(configPatch ? { configPatch } : {}),
    profiles: [tokenProfile("moonshot:token", "moonshot", "moonshot-token")],
  });
  useProvider("moonshot", "Moonshot", [
    { id: "setup-token", label: "setup-token", kind: "token", run: runTokenAuth },
  ]);
  return runTokenAuth;
}

function expectCoderStore(runAuth: { mock: { calls: unknown[][] } }) {
  expect(mocks.resolveDefaultAgentId).not.toHaveBeenCalled();
  expect(runAuth.mock.calls[0]?.[0]).toMatchObject({
    agentDir: "/tmp/openclaw/agents/coder",
    workspaceDir: "/tmp/openclaw/workspaces/coder",
  });
  expect(mocks.persistProviderAuthProfilesAfterLogin.mock.calls[0]?.[0]).toMatchObject({
    agentDir: "/tmp/openclaw/agents/coder",
  });
}

function expectRefresh(agentId = "main") {
  expect(mocks.callGateway).toHaveBeenCalledWith(
    expect.objectContaining({
      method: "models.authRefresh",
      params: { operation: "login", agentId },
    }),
  );
}

it.each([
  { profileId: undefined, expectedIds: ["openai:first", "openai:second"] },
  { profileId: "openai:first", expectedIds: ["openai:first"] },
])(
  "passes only permitted stored profiles to login (profile=$profileId)",
  async ({ profileId, expectedIds }) => {
    const credential = {
      type: "oauth",
      provider: "openai",
      access: "synthetic-expired-access",
      refresh: "synthetic-refresh",
      expires: 1,
      clientId: "synthetic-client",
      authorizationScope: "openid profile resource.invoke offline_access",
    } as const;
    const profiles: Record<string, ProviderAuthProfile["credential"]> = {
      "openai:first": credential,
      "openai:second": { ...credential, clientId: "another-registration" },
      "other:private": { ...credential, provider: "other" },
    };
    mocks.loadAuthProfileStoreWithoutExternalProfiles.mockReturnValue({ version: 1, profiles });
    runProviderAuth.mockResolvedValueOnce({
      profiles: [{ profileId: profileId ?? "openai:first", credential }],
    });

    await loginCommand({ provider: "openai", profileId });

    expect(runProviderAuth.mock.calls[0]?.[0].existingProfiles).toEqual(
      expectedIds.map((id) => ({ profileId: id, credential: profiles[id] })),
    );
    expect(mocks.loadAuthProfileStoreWithoutExternalProfiles).toHaveBeenCalledWith(
      "/tmp/openclaw/agents/main",
    );
    expect(mocks.persistProviderAuthProfilesAfterLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        profiles: [{ profileId: profileId ?? "openai:first", credential }],
      }),
    );
    expect(mocks.promoteAuthProfileInOrder).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", profileId: profileId ?? "openai:first" }),
    );
  },
);

it("rejects a named login with multiple returned profiles before persisting", async () => {
  runProviderAuth.mockResolvedValueOnce({
    profiles: ["one", "two"].map((id) => ({
      profileId: `openai:${id}`,
      credential: { type: "api_key", provider: "openai", key: `synthetic-${id}` },
    })),
  });

  await expect(loginCommand({ provider: "openai", profileId: "openai:work" })).rejects.toThrow(
    "--profile-id requires exactly one returned auth profile",
  );
  expectNoCalls(
    mocks.persistProviderAuthProfilesAfterLogin,
    mocks.promoteAuthProfileInOrder,
    mocks.updateConfig,
    mocks.callGateway,
  );
});

it("does not promote a login profile when protected storage rejects", async () => {
  runProviderAuth.mockResolvedValueOnce({
    profiles: [
      {
        ...tokenProfile("github-copilot:github", "github-copilot", "synthetic-device-token"),
        secretStorage: { kind: "store", namePrefix: "GITHUB_COPILOT_TOKEN" },
      },
    ],
  });
  useProvider("github-copilot", "GitHub Copilot");
  mocks.persistProviderAuthProfilesAfterLogin.mockRejectedValueOnce(
    new Error("Could not write the protected secret store"),
  );

  await expect(loginCommand({ provider: "github-copilot" })).rejects.toThrow(
    "Could not write the protected secret store",
  );

  expect(mocks.persistProviderAuthProfilesAfterLogin).toHaveBeenCalledOnce();
  expectNoCalls(mocks.promoteAuthProfileInOrder, mocks.updateConfig, mocks.callGateway);
});

it.each([
  { connected: true, outcome: "gateway-rejected", target: "running" },
  { connected: false, outcome: "gateway-unreachable", target: "local" },
])(
  "keeps saved login credentials when refresh is $outcome",
  async ({ connected, outcome, target }) => {
    mocks.callGateway.mockImplementationOnce(async (options: { onHelloOk?: () => void }) => {
      if (connected) {
        options.onHelloOk?.();
      }
      throw new Error("refresh rejected");
    });

    await expect(loginFlow()).resolves.toMatchObject({ authRefresh: outcome });

    expect(mocks.persistProviderAuthProfilesAfterLogin).toHaveBeenCalledOnce();
    expectRefresh();
    expect(runtime.error).toHaveBeenCalledWith(
      `Warning: Model auth changes were saved, but the ${target} Gateway could not refresh them. Run \`openclaw gateway restart\` to apply the saved changes.`,
    );
  },
);

it("retains the imported profile and model-access choice after direct refresh fails", async () => {
  const profileId = "openai:imported";
  currentConfig = {
    agents: {
      defaults: { model: "other/current", modelPolicy: { allow: ["other/current"] } },
    },
  };
  mocks.tryImportProviderCredential.mockResolvedValueOnce({
    profileId,
    provider: "openai",
    mode: "oauth",
    configUpdated: false,
  });
  const onModelAccessRequested = vi.fn();
  const result = await loginFlow({
    refreshAfterLogin: async () => {
      throw new Error("Auth publication failed.");
    },
    onModelAccessRequested,
  });
  expect(result).toMatchObject({
    authRefresh: "gateway-rejected",
    profiles: [{ profileId, provider: "openai", mode: "oauth" }],
  });
  expect(onModelAccessRequested).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      provider: "openai",
      policy: { path: "agents.defaults.modelPolicy.allow", refs: ["other/current"] },
    }),
  );
  expect(currentConfig.agents?.defaults).toEqual({
    model: "other/current",
    modelPolicy: { allow: ["other/current"] },
  });
});

it("identifies a config failure after credentials are saved and preserves its cause", async () => {
  const cause = new Error("config write failed");
  runProviderAuth.mockResolvedValueOnce({
    profiles: [tokenProfile("openai:saved")],
    configPatch: { logging: { level: "debug" } },
  });
  mocks.updateConfig.mockRejectedValueOnce(cause);

  const login = loginFlow();
  await expect(login).rejects.toBeInstanceOf(ProviderAuthConfigApplyError);
  await expect(login).rejects.toMatchObject({
    name: "ProviderAuthConfigApplyError",
    message: "Credentials saved, but provider settings could not be applied: config write failed",
    cause,
  });
  expect(mocks.persistProviderAuthProfilesAfterLogin).toHaveBeenCalledOnce();
  expect(mocks.callGateway).not.toHaveBeenCalled();
});

it("creates store order for relogin when configured profiles would shadow the new profile", async () => {
  currentConfig = {
    auth: {
      profiles: {
        "openai:old-login": { provider: "openai", mode: "oauth" },
      },
    },
  };

  await loginCommand();

  expect(mocks.updateConfig).not.toHaveBeenCalled();
  expect(mocks.promoteAuthProfileInOrder).toHaveBeenCalledWith({
    agentDir: "/tmp/openclaw/agents/main",
    provider: "openai",
    profileId: "openai:user@example.com",
    createIfMissing: true,
    createFromOrder: ["openai:old-login"],
  });
});

it("defaults OpenAI login to ChatGPT OAuth when API key is also available", async () => {
  const initialConfig = currentConfig;
  const runOauthAuth = vi.fn().mockResolvedValue({ profiles: [oauthProfile()] });
  const runApiKeyAuth = vi.fn().mockResolvedValue({ profiles: [] });
  const { select } = usePrompter();
  useProvider("openai", "OpenAI runtime", [
    { id: "api-key", label: "OpenAI API Key", kind: "api_key", run: runApiKeyAuth },
  ]);
  mocks.resolvePluginSetupProviderCore.mockReturnValue(
    createOpenAISetupProvider(runOauthAuth, runApiKeyAuth),
  );

  await loginCommand();

  expect(mocks.resolvePluginSetupProviderCore).toHaveBeenCalledWith({
    provider: "openai",
    config: initialConfig,
    workspaceDir: "/tmp/openclaw/workspace",
  });
  expect(runOauthAuth).toHaveBeenCalledOnce();
  expectNoCalls(runApiKeyAuth, select);
});

it("prompts when a provider exposes multiple non-OAuth login methods", async () => {
  const runApiKeyAuth = vi.fn().mockResolvedValue({ profiles: [] });
  const runCliAuth = vi.fn().mockResolvedValue({ profiles: [] });
  const { select } = usePrompter(vi.fn().mockResolvedValue("cli"));
  useProvider("anthropic", "Anthropic", [
    { id: "api-key", label: "Anthropic API Key", kind: "api_key", run: runApiKeyAuth },
    { id: "cli", label: "Claude CLI", kind: "custom", run: runCliAuth },
  ]);

  await loginCommand({ provider: "anthropic" });

  expect(select).toHaveBeenCalledWith({
    message: "Auth method for Anthropic",
    options: [
      { value: "api-key", label: "Anthropic API Key", hint: undefined },
      { value: "cli", label: "Claude CLI", hint: undefined },
    ],
  });
  expect(runApiKeyAuth).not.toHaveBeenCalled();
  expect(runCliAuth).toHaveBeenCalledOnce();
});

it("routes OAuth login and refresh to the explicit agent", async () => {
  const originalConfig = useCoderAgentConfig();
  const { note } = usePrompter();

  await loginCommand({ provider: "openai", agent: "coder" });

  expect(note).toHaveBeenCalledWith(
    [
      "Scope: System / agent",
      "Agent: coder",
      "Location: the machine running OpenClaw",
      "For personal model accounts on a Gateway, run openclaw models accounts login --help.",
    ].join("\n"),
    "Provider sign-in",
  );
  expect(note.mock.invocationCallOrder[0]).toBeLessThan(
    runProviderAuth.mock.invocationCallOrder[0]!,
  );
  expect(mocks.resolveAgentDir).toHaveBeenCalledWith(originalConfig, "coder");
  expectCoderStore(runProviderAuth);
  expectRefresh("coder");
});

it("refreshes saved credentials before presenting provider notes", async () => {
  const note = vi.fn(async (_message: string, title?: string) => {
    if (title === "Provider notes") {
      throw new Error("note delivery failed");
    }
  });
  usePrompter(vi.fn(), note);
  runProviderAuth.mockResolvedValue({
    profiles: [tokenProfile("openai:proof")],
    notes: ["Provider sign-in details"],
  });
  await expect(loginCommand()).rejects.toThrow("note delivery failed");
  expectRefresh();
});

it("does not persist credentials returned after app-owned cancellation", async () => {
  const abortController = new AbortController();
  const cancellation = new Error("Login was replaced");
  runProviderAuth.mockImplementationOnce(async (params: AuthRunCall) => {
    expect(params.signal).toBe(abortController.signal);
    abortController.abort(cancellation);
    return {
      profiles: [
        oauthProfile("openai:late@example.com", {
          access: "late-access-token",
          refresh: "late-refresh-token",
          email: undefined,
        }),
      ],
    };
  });

  await expect(
    loginFlow({
      method: "oauth",
      config: currentConfig,
      signal: abortController.signal,
    }),
  ).rejects.toBe(cancellation);

  expectNoCalls(
    mocks.removeProviderAuthProfilesWithLock,
    mocks.upsertAuthProfileWithLock,
    mocks.persistProviderAuthProfilesAfterLogin,
    mocks.promoteAuthProfileInOrder,
    mocks.updateConfig,
  );
});

it("runs the requested anthropic cli auth method with the full login context", async () => {
  currentConfig = { agents: { defaults: claudeDefaults("anthropic") } };
  const migrated = claudeDefaults("claude-cli");
  const { note, select } = usePrompter();
  const runApiKeyAuth = vi.fn();
  const runClaudeCliMigration = vi.fn().mockImplementation(async (ctx) => {
    expect(ctx.config).toEqual(currentConfig);
    expect(ctx).toMatchObject({
      agentDir: "/tmp/openclaw/agents/main",
      workspaceDir: "/tmp/openclaw/workspace",
      allowSecretRefPrompt: false,
      isRemote: false,
    });
    expect(ctx.prompter.note).toBe(note);
    expect(ctx.prompter.select).toBe(select);
    expect(ctx.runtime).toBe(runtime);
    expect(ctx.env).toBe(process.env);
    await ctx.openUrl("https://example.com/auth");
    expect(mocks.openUrl).toHaveBeenCalledWith("https://example.com/auth");
    expect(ctx.oauth.createVpsAwareHandlers).toBeTypeOf("function");
    return {
      profiles: [],
      defaultModel: "claude-cli/claude-sonnet-4-6",
      configPatch: { agents: { defaults: migrated } },
      replaceDefaultModels: true,
      notes: [
        "Claude CLI auth detected; switched Anthropic model selection to the local Claude CLI backend.",
        "Existing Anthropic auth profiles are kept for rollback.",
      ],
    };
  });
  useProvider("anthropic", "Anthropic", [
    { id: "cli", label: "Claude CLI", kind: "custom", run: runClaudeCliMigration },
    { id: "api-key", label: "Anthropic API key", kind: "api_key", run: runApiKeyAuth },
  ]);

  await loginCommand({ provider: "anthropic", method: "cli", setDefault: true });

  expect(runClaudeCliMigration).toHaveBeenCalledOnce();
  expect(mocks.resolvePluginProvidersCore).toHaveBeenCalledWith(
    expect.objectContaining({
      providerRefs: ["anthropic"],
      includeUntrustedWorkspacePlugins: false,
    }),
  );
  expectNoCalls(runApiKeyAuth, mocks.upsertAuthProfileWithLock);
  expect(lastUpdatedConfig?.agents?.defaults?.model).toEqual(migrated.model);
  expect(lastUpdatedConfig?.agents?.defaults?.models).toEqual(migrated.models);
  expect(note).toHaveBeenCalledWith(
    [
      "Claude CLI auth detected; switched Anthropic model selection to the local Claude CLI backend.",
      "Existing Anthropic auth profiles are kept for rollback.",
    ].join("\n"),
    "Provider notes",
  );
  expect(runtime.log).toHaveBeenCalledWith("Default model set to claude-cli/claude-sonnet-4-6");
});

it("preserves model selection and other providers' allowlist entries on OAuth login", async () => {
  const existingModels = {
    "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
    "anthropic/claude-opus-4-6": { alias: "opus" },
    "moonshot/kimi-k2.5": { alias: "kimi" },
    "openai/gpt-5.5": { alias: "gpt55" },
  };
  const model = {
    primary: "anthropic/claude-sonnet-4-6",
    fallbacks: ["moonshot/kimi-k2.5"],
  };
  currentConfig = structuredClone({ agents: { defaults: { model, models: existingModels } } });
  runProviderAuth.mockResolvedValue({
    profiles: [oauthProfile(undefined, { access: "a", refresh: "r" })],
    configPatch: {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.5" }, models: { "openai/gpt-5.5": {} } },
      },
    },
    defaultModel: "openai/gpt-5.5",
  });

  await loginCommand();

  expect(currentConfig.agents?.defaults?.models).toEqual(existingModels);
  expect(currentConfig.agents?.defaults?.model).toEqual(model);
});

it("--force refreshes after the purge when replacement login fails", async () => {
  runProviderAuth.mockRejectedValueOnce(new Error("provider rejected login"));

  await expect(loginCommand({ provider: "openai", force: true })).rejects.toThrow(
    "provider rejected login",
  );

  expect(mocks.removeProviderAuthProfilesWithLock).toHaveBeenCalledOnce();
  expect(mocks.callGateway).toHaveBeenCalledOnce();
  expect(mocks.removeProviderAuthProfilesWithLock.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.callGateway.mock.invocationCallOrder[0]!,
  );
  expect(mocks.callGateway.mock.invocationCallOrder[0]).toBeLessThan(
    runProviderAuth.mock.invocationCallOrder[0]!,
  );
});

it("--force fails before login when purge cannot update the profile store", async () => {
  mocks.removeProviderAuthProfilesWithLock.mockResolvedValueOnce(null);

  await expect(loginCommand({ provider: "openai", force: true })).rejects.toThrow(
    'Could not clear cached profiles for "openai" before re-login: auth store is busy; close other OpenClaw commands using this state directory and retry',
  );

  expectNoCalls(runtime.error, runProviderAuth);
});

it("rejects unknown auth methods before a forced login can purge profiles", async () => {
  const runOauthAuth = vi.fn().mockResolvedValue({ profiles: [] });
  const runApiKeyAuth = vi.fn().mockResolvedValue({ profiles: [] });
  mocks.resolvePluginSetupProviderCore.mockReturnValue(
    createOpenAISetupProvider(runOauthAuth, runApiKeyAuth),
  );

  await expect(
    loginCommand({ provider: "openai", method: "api_key", force: true }),
  ).rejects.toThrow("Unknown auth method");

  expectNoCalls(mocks.removeProviderAuthProfilesWithLock, runOauthAuth, runApiKeyAuth);
});

it("opens the provider picker when a CLI backend has no provider auth method", async () => {
  const prompter = usePrompter(vi.fn(async () => "openai"));
  mocks.isCliProvider.mockImplementation((provider: string) => provider === "claude-cli");
  const openaiProvider = createProvider("openai", "OpenAI Codex");
  mocks.resolvePluginProvidersCore.mockImplementation(
    (params: ResolvePluginProvidersCall | undefined) =>
      params?.providerRefs?.includes("claude-cli") ? [] : [openaiProvider],
  );

  await loginCommand({ provider: "claude-cli" });

  expect(prompter.note).toHaveBeenCalledWith(
    'Provider "claude-cli" uses its own CLI login. Select a provider with an OpenClaw auth flow.',
    "Provider auth",
  );
  expect(prompter.select).toHaveBeenCalledWith(
    expect.objectContaining({ message: "Select a provider" }),
  );
  expect(runProviderAuth).toHaveBeenCalledOnce();
  expect(mocks.resolvePluginProvidersCore).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ providerRefs: ["claude-cli"] }),
  );
  expect(mocks.resolvePluginProvidersCore).toHaveBeenNthCalledWith(
    2,
    expect.not.objectContaining({ providerRefs: expect.anything() }),
  );
});

it("rejects the retired manual auth provider codex-cli", async () => {
  const provider = "codex-cli";
  await expect(loginCommand({ provider })).rejects.toThrow(
    `"${provider}" is a legacy provider ID; use --provider openai.`,
  );
});

it("writes pasted Anthropic setup-tokens and logs the preference note", async () => {
  mocks.clackPassword.mockResolvedValue(`sk-ant-oat01-${"a".repeat(80)}`);

  await modelsAuthPasteTokenCommand({ provider: "anthropic" }, runtime);

  expect(mocks.clackPassword).toHaveBeenCalledOnce();
  expect(mocks.clackText).not.toHaveBeenCalled();
  expect(mocks.upsertAuthProfileWithLock).toHaveBeenCalledWith({
    profileId: "anthropic:manual",
    credential: {
      type: "token",
      provider: "anthropic",
      token: `sk-ant-oat01-${"a".repeat(80)}`,
    },
    agentDir: "/tmp/openclaw/agents/main",
  });
  expect(runtime.log).toHaveBeenCalledWith("Anthropic setup-token auth is supported in OpenClaw.");
  expect(runtime.log).toHaveBeenCalledWith(
    "OpenClaw prefers Claude CLI reuse when it is available on the host.",
  );
  expect(runtime.log).toHaveBeenCalledWith(
    "Anthropic staff told us this OpenClaw path is allowed again.",
  );
});

it("rejects pasted token expiries that cannot fit in the Date timestamp range", async () => {
  const nowSpy = vi.spyOn(Date, "now").mockReturnValue(MAX_DATE_TIMESTAMP_MS);
  mocks.clackPassword.mockResolvedValue("openai-token");
  try {
    await expect(
      modelsAuthPasteTokenCommand({ provider: "openai", expiresIn: "1ms" }, runtime),
    ).rejects.toThrow("resulting token expiry is outside Date range");
  } finally {
    nowSpy.mockRestore();
  }

  expectNoCalls(mocks.upsertAuthProfileWithLock, mocks.updateConfig);
});

it.each([
  {
    name: "line-wrapped API key used as a token",
    input: "sk-openai-\nchat-api-key-value\n",
    command: modelsAuthPasteTokenCommand,
    error: "paste-api-key --provider openai",
  },
  {
    name: "malformed UTF-8 token",
    input: Buffer.from([0x74, 0xff, 0x6b]),
    command: modelsAuthPasteTokenCommand,
    error: "Piped auth input must be valid UTF-8.",
  },
  {
    name: "oversized auth input",
    input: "x".repeat(1024 * 1024 + 1),
    command: modelsAuthPasteApiKeyCommand,
    error: "Piped auth input exceeds 1048576 bytes.",
  },
])("rejects piped $name before prompting or writing", async ({ input, command, error }) => {
  pipeInput(input);
  await expect(command({ provider: "openai" }, runtime)).rejects.toThrow(error);
  expectNoCalls(mocks.clackPassword, mocks.upsertAuthProfileWithLock, mocks.updateConfig);
});

it("writes pasted API keys to the requested agent store", async () => {
  useCoderAgentConfig();
  pipeInput("sk-openai-\nchat-api-key-value\n");

  await modelsAuthPasteApiKeyCommand({ provider: "openai", agent: "coder" }, runtime);

  expectNoCalls(mocks.clackPassword, mocks.resolveDefaultAgentId);
  expect(mocks.upsertAuthProfileWithLock).toHaveBeenCalledWith({
    profileId: "openai:manual",
    credential: { type: "api_key", provider: "openai", key: "sk-openai-chat-api-key-value" },
    agentDir: "/tmp/openclaw/agents/coder",
    preserveApiKeyMetadata: true,
    resetFailureState: true,
    validateCurrentCredential: expect.any(Function),
  });
  expect(lastUpdatedConfig?.auth?.profiles?.["openai:manual"]).toEqual({
    provider: "openai",
    mode: "api_key",
  });
  expect(runtime.log).toHaveBeenCalledWith("Auth profile: openai:manual (openai/api_key)");
  expect(runtime.error).toHaveBeenCalledWith(
    expect.stringContaining("Gateway has not confirmed applying the provider settings"),
  );
  expectRefresh("coder");
});

it("rejects token material pasted into the OpenAI Codex API-key command", async () => {
  const jwtLikeToken = ["eyJhbGciOiJub25l", "eyJzdWIiOiJjb2RleCJ9", "signature123456"].join(".");
  mocks.clackPassword.mockResolvedValue(jwtLikeToken);

  await expect(modelsAuthPasteApiKeyCommand({ provider: "openai" }, runtime)).rejects.toThrow(
    "paste-token --provider openai",
  );

  expectNoCalls(mocks.upsertAuthProfileWithLock, mocks.updateConfig);
});

it("rejects an unknown agent before prompting for pasted tokens", async () => {
  currentConfig = { agents: { entries: { main: {} } } };

  await expect(
    modelsAuthPasteTokenCommand({ provider: "openai", agent: "missing" }, runtime),
  ).rejects.toThrow(
    'Unknown agent id "missing". Use "openclaw agents list" to see configured agents.',
  );

  expectNoCalls(mocks.clackPassword, mocks.upsertAuthProfileWithLock, mocks.updateConfig);
});

it("uses the requested agent store for setup-token provider auth", async () => {
  useCoderAgentConfig();
  const runTokenAuth = useTokenProvider();

  await modelsAuthSetupTokenCommand({ provider: "moonshot", yes: true, agent: "coder" }, runtime);

  expectCoderStore(runTokenAuth);
});

it("uses the requested agent store for interactive token auth add", async () => {
  useCoderAgentConfig();
  const runTokenAuth = useTokenProvider({ logging: { level: "debug" } });
  mocks.clackSelect.mockResolvedValueOnce("moonshot").mockResolvedValueOnce("setup-token");

  await modelsAuthAddCommand({ agent: "coder" }, runtime);

  expect(lastUpdatedConfig?.logging?.level).toBe("debug");
  expectCoderStore(runTokenAuth);
});

it("keeps the requested agent store when interactive auth add falls back to paste-token", async () => {
  useCoderAgentConfig();
  mocks.resolvePluginProvidersCore.mockReturnValue([]);
  mocks.clackSelect.mockResolvedValue("custom");
  mocks.clackText.mockResolvedValueOnce("openai").mockResolvedValueOnce("openai:manual");
  mocks.clackPassword.mockResolvedValue("openai-token");
  mocks.clackConfirm.mockResolvedValue(false);

  await modelsAuthAddCommand({ agent: "coder" }, runtime);

  expect(mocks.resolveDefaultAgentId).not.toHaveBeenCalled();
  expect(mocks.upsertAuthProfileWithLock).toHaveBeenCalledWith({
    profileId: "openai:manual",
    credential: { type: "token", provider: "openai", token: "openai-token" },
    agentDir: "/tmp/openclaw/agents/coder",
  });
});
