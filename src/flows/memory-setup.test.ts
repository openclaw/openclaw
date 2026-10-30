import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import {
  configFor,
  configForProviders,
  providerEntry,
} from "../agents/model-auth.fixtures.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  EmbeddingProviderAdapter,
  EmbeddingProvider,
  EmbeddingProviderCreateResult,
} from "../plugins/embedding-provider-types.js";
import type { MemoryEmbeddingProviderAdapter } from "../plugins/memory-embedding-providers.js";
import { createDeferredCore } from "../shared/deferred.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { runMemorySetupFlow } from "./memory-setup.js";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(() => ({ index: { plugins: [] }, plugins: [] })),
  manifestIds: vi.fn(() => ["remote-a", "remote-b", "local"]),
  alias: vi.fn((_id: string) => undefined as string | undefined),
  get: vi.fn((_id: string) => undefined as EmbeddingProviderAdapter | undefined),
  promptRef: vi.fn(),
  resolveRef: vi.fn(),
  resolveCommand: vi.fn(),
}));

// mock-isolation: Provider discovery uses a fixture manifest, not operator plugin metadata.
vi.mock("../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestContractSnapshot: mocks.snapshot,
  listAvailableManifestContractValues: mocks.manifestIds,
}));
vi.mock(import("../plugins/embedding-provider-config.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  resolveConfiguredGenericEmbeddingProviderId: mocks.alias,
}));
// mock-isolation: Provider selection is fixture-owned and must not resolve the active plugin registry.
vi.mock("../plugins/embedding-provider-runtime.js", () => ({ getEmbeddingProvider: mocks.get }));
// mock-isolation: Secret prompts must not load operator auth stores or execute secret providers.
vi.mock("../plugins/provider-auth-ref.js", () => ({
  promptSecretRefForSetup: mocks.promptRef,
}));
// mock-isolation: Existing credentials resolve from fixtures, without Gateway or secret-store access.
vi.mock("../wizard/setup.secret-input.js", () => ({
  resolveSetupSecretInputString: mocks.resolveRef,
}));
// mock-isolation: Config resolution must not contact Gateway secret owners in this flow test.
vi.mock("../cli/command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets: mocks.resolveCommand,
}));
// mock-isolation: Use fixed memory secret targets without loading other plugin/channel targets.
vi.mock("../cli/command-secret-targets.js", () => ({
  getMemoryEmbeddingCommandSecretTargetIds: () => new Set(["models.providers.*.apiKey"]),
}));

function embeddingProvider(overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
  return {
    id: "remote-a",
    model: "embed-default",
    embed: vi.fn(async () => [0.1, 0.2]),
    embedBatch: vi.fn(async () => [[0.1, 0.2]]),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

function adapter(
  id = "remote-a",
  provider = embeddingProvider({ id }),
): MemoryEmbeddingProviderAdapter {
  return {
    id,
    defaultModel: "embed-default",
    transport: "remote",
    authProviderId: id,
    create: vi.fn(async () => ({ provider })),
  };
}

function memoryConfig(search: NonNullable<OpenClawConfig["memory"]>["search"]): OpenClawConfig {
  return { memory: { search } };
}
const secretRef = (id: string) => ({ source: "env" as const, provider: "default", id });

function prompter(params: { confirms?: boolean[]; selects?: string[]; texts?: string[] } = {}) {
  const confirms = [...(params.confirms ?? [true, true])];
  const selects = [...(params.selects ?? ["remote-a", "existing"])];
  const texts = [...(params.texts ?? ["embed-default"])];
  return createWizardPrompter({
    confirm: vi.fn(async () => confirms.shift() ?? false),
    select: vi.fn(async () => selects.shift() ?? "") as never,
    text: vi.fn(async () => texts.shift() ?? ""),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.manifestIds.mockReturnValue(["remote-a", "remote-b", "local"]);
  mocks.get.mockImplementation((id) => adapter(id));
  mocks.alias.mockReturnValue(undefined);
  mocks.resolveCommand.mockImplementation(async ({ config }: { config: OpenClawConfig }) => ({
    effectiveConfig: config,
  }));
});
afterEach(() => vi.useRealTimers());

it("preserves per-agent multimodal config for an incompatible provider", async () => {
  const chosen = adapter("openai");
  chosen.supportsMultimodalEmbeddings = () => false;
  mocks.get.mockReturnValue(chosen);
  const config: OpenClawConfig = {
    ...memoryConfig({
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      fallback: "none",
      query: { maxResults: 7 },
    }),
    agents: {
      entries: {
        main: { memory: { search: { multimodal: { enabled: true, modalities: ["image"] } } } },
      },
    },
  };
  const original = structuredClone(config);
  const prompt = prompter({ selects: ["openai", "existing"], texts: ["text-embedding-3-small"] });
  const result = await runMemorySetupFlow(config, prompt);
  expect(result).toBe(config);
  expect(config).toEqual(original);
  expect(chosen.create).not.toHaveBeenCalled();
  expect(prompt.confirm).toHaveBeenCalledOnce();
  expect(prompt.note).toHaveBeenCalledWith(
    expect.stringContaining("compatible"),
    "Memory setup unchanged",
  );
});

it("skips before catalog or provider runtime access and preserves identity", async () => {
  const config = memoryConfig({ enabled: false });
  const result = await runMemorySetupFlow(config, prompter({ confirms: [false] }));
  expect(result).toBe(config);
  expect(mocks.snapshot).not.toHaveBeenCalled();
  expect(mocks.get).not.toHaveBeenCalled();
});

it.each([
  { mode: "ref", key: secretRef("EMBED_KEY"), resolved: "probe-secret" },
  { mode: "existing", key: secretRef("CURRENT_EMBED_KEY"), resolved: "current-probe-key" },
  { mode: "key", key: "typed-key", resolved: "typed-key" },
])(
  "saves $mode credentials separately from the resolved probe key",
  async ({ mode, key, resolved }) => {
    mocks.promptRef.mockResolvedValue({ ref: key, resolvedValue: resolved });
    mocks.resolveRef.mockResolvedValue(resolved);
    const chosen = adapter();
    mocks.get.mockReturnValue(chosen);
    const config =
      mode === "existing"
        ? memoryConfig({ provider: "remote-a", model: "embed-default", remote: { apiKey: key } })
        : {};
    const prompts = prompter({
      selects: ["remote-a", mode],
      texts: ["embed-default", "typed-key"],
    });
    const result = await runMemorySetupFlow(config, prompts, {
      secretInputMode: mode === "existing" ? "ref" : "plaintext",
    });
    expect(result.memory?.search?.remote?.apiKey).toEqual(key);
    expect(chosen.create).toHaveBeenCalledWith(
      expect.objectContaining({ remote: { apiKey: resolved } }),
    );
    if (mode === "ref") {
      expect(mocks.resolveRef).not.toHaveBeenCalled();
    } else if (mode === "existing") {
      const credentialPrompt = vi.mocked(prompts.select).mock.calls[1]?.[0];
      expect(credentialPrompt?.initialValue).toBe("existing");
      expect(credentialPrompt?.options.map((entry) => entry.value)).toEqual(["existing", "ref"]);
    } else if (mode === "key") {
      expect(vi.mocked(prompts.text).mock.calls[1]?.[0]).toMatchObject({ sensitive: true });
      expect(mocks.get.mock.calls.every(([id]) => id === "remote-a")).toBe(true);
    }
  },
);

it("offers configured native aliases only for available HTTP embedding owners", async () => {
  mocks.manifestIds.mockReturnValue(["ollama", "local"]);
  const owners = new Map([
    ["local-box", "ollama"],
    ["disabled-box", "lmstudio"],
    ["managed-box", "local"],
  ]);
  mocks.alias.mockImplementation((id) => owners.get(id));
  const prompts = prompter({ selects: ["local-box", "existing"] });
  await runMemorySetupFlow(
    configForProviders(
      Object.fromEntries(
        [...owners.keys()].map((id) => [id, providerEntry("http://localhost:11434")]),
      ),
    ),
    prompts,
  );
  expect(vi.mocked(prompts.select).mock.calls[0]?.[0].options.map((entry) => entry.value)).toEqual([
    "local-box",
    "ollama",
  ]);
});

it.each([
  { selected: "gemini", owner: "google", keyPath: "models.providers.google.apiKey" },
  {
    selected: "tenant.example",
    owner: "tenant.example",
    keyPath: 'models.providers["tenant.example"].apiKey',
  },
  {
    selected: "local-box",
    owner: "local-box",
    adapterOwner: "ollama",
    keyPath: "models.providers.local-box.apiKey",
  },
])(
  "resolves only $owner credentials for $selected",
  async ({ selected, owner, adapterOwner, keyPath }) => {
    const ref = secretRef("MODEL_EMBED_KEY");
    const config = configFor(owner, "https://remote.example/v1", {
      api: "openai-completions",
      apiKey: ref,
      headers: { "X.Tenant.Key": "${MODEL_EMBED_HEADER}" },
    });
    mocks.resolveCommand.mockImplementation(
      async ({
        config: draft,
        allowedPaths,
      }: {
        config: OpenClawConfig;
        allowedPaths: Set<string>;
      }) => {
        expect(allowedPaths).toEqual(
          new Set([keyPath, keyPath.replace(/\.apiKey$/, '.headers["X.Tenant.Key"]')]),
        );
        const effectiveConfig = structuredClone(draft);
        effectiveConfig.models!.providers![owner]!.apiKey = "probe-only-key";
        return { effectiveConfig };
      },
    );
    const chosen = { ...adapter(selected), authProviderId: adapterOwner ?? owner };
    mocks.get.mockReturnValue(chosen);
    const result = await runMemorySetupFlow(config, prompter({ selects: [selected, "existing"] }));
    expect(result.models?.providers?.[owner]?.apiKey).toEqual(ref);
    expect(
      vi.mocked(chosen.create).mock.calls[0]?.[0].config.models?.providers?.[owner],
    ).toMatchObject({ apiKey: "probe-only-key" });
  },
);

it("does not send old destination credentials or headers to a new provider", async () => {
  const chosen = adapter("remote-b");
  mocks.get.mockReturnValue(chosen);
  const config = memoryConfig({
    provider: "remote-a",
    model: "old",
    remote: {
      baseUrl: "https://old.example",
      apiKey: "old-secret",
      headers: { Authorization: "old-secret" },
      batch: { enabled: false },
    },
  });
  const result = await runMemorySetupFlow(config, prompter({ selects: ["remote-b", "existing"] }));
  expect(chosen.create).toHaveBeenCalledWith(
    expect.objectContaining({ remote: { batch: { enabled: false } } }),
  );
  expect(result.memory?.search?.remote).toEqual({ batch: { enabled: false } });
});

it.each(["invalid vector", "provider error"])(
  "keeps config and redacts failed readiness (%s)",
  async (failure) => {
    const config: OpenClawConfig = {};
    const provider = embeddingProvider({
      embed: vi.fn(async () => {
        if (failure === "provider error") {
          throw new Error("credential=private-probe-value rejected");
        }
        return [Number.NaN];
      }),
      embedBatch: vi.fn(),
    });
    if (failure === "invalid vector") {
      provider.close = undefined;
    }
    mocks.get.mockReturnValue(adapter("remote-a", provider));
    const prompts = prompter();
    expect(await runMemorySetupFlow(config, prompts)).toBe(config);
    expect(JSON.stringify(vi.mocked(prompts.note).mock.calls)).not.toContain("private-probe-value");
  },
);

it("keeps the original config on save refusal and cancellation", async () => {
  const config: OpenClawConfig = {};
  expect(await runMemorySetupFlow(config, prompter({ confirms: [true, false] }))).toBe(config);
  const cancelled = prompter();
  vi.mocked(cancelled.text).mockRejectedValueOnce(new WizardCancelledError());
  await expect(runMemorySetupFlow(config, cancelled)).rejects.toBeInstanceOf(WizardCancelledError);
});

it("aborts a hanging embedding call and bounds a hanging close", async () => {
  vi.useFakeTimers();
  const started = createDeferredCore();
  let signal: AbortSignal | undefined;
  const provider = embeddingProvider({
    embed: vi.fn((_input, options) => {
      signal = options?.signal;
      started.resolve();
      return new Promise<number[]>(() => {});
    }),
    embedBatch: vi.fn(async () => []),
    close: vi.fn(() => new Promise<void>(() => {})),
  });
  mocks.get.mockReturnValue(adapter("remote-a", provider));
  const config: OpenClawConfig = {};
  const running = runMemorySetupFlow(config, prompter());
  await started.promise;
  await vi.advanceTimersByTimeAsync(150_000);
  expect(signal?.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await running).toBe(config);
  expect(provider.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("times out creation and closes a provider created after the deadline", async () => {
  vi.useFakeTimers();
  const created = createDeferredCore<EmbeddingProviderCreateResult>();
  const started = createDeferredCore();
  const close = vi.fn(async () => {});
  const late = adapter();
  late.create = vi.fn(() => {
    started.resolve();
    return created.promise;
  });
  mocks.get.mockReturnValue(late);
  const config: OpenClawConfig = {};
  const running = runMemorySetupFlow(config, prompter());
  await started.promise;
  await vi.advanceTimersByTimeAsync(150_000);
  expect(await running).toBe(config);
  created.resolve({
    provider: embeddingProvider({ embed: vi.fn(), embedBatch: vi.fn(), close }),
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(close).toHaveBeenCalledOnce();
});

it.each<{ label: string; search: NonNullable<NonNullable<OpenClawConfig["memory"]>["search"]> }>([
  { label: "own key", search: { remote: { apiKey: "agent-owner-key" } } },
  {
    label: "own headers",
    search: { remote: { headers: { Authorization: "Bearer agent-owner" } } },
  },
  { label: "own router", search: { remote: { baseUrl: "https://agent.example/v1" } } },
  { label: "pinned provider", search: { provider: "remote-a" } },
  { label: "disabled agent", search: { enabled: false, remote: { apiKey: "disabled-owner-key" } } },
])(
  "preserves the previous effective destination on provider switch: $label",
  async ({ search }) => {
    const config: OpenClawConfig = {
      memory: {
        search: {
          provider: "remote-a",
          model: "previous-model",
          remote: {
            baseUrl: "https://shared.example/v1",
            apiKey: secretRef("PREVIOUS_EMBED_KEY"),
            headers: { "X-Owner": "previous" },
          },
        },
      },
      agents: { entries: { worker: { memory: { search } }, plain: {} } },
    };
    const original = structuredClone(config);
    const result = await runMemorySetupFlow(
      config,
      prompter({ selects: ["remote-b", "key"], texts: ["new-model", "new-owner-key"] }),
    );
    expect(config).toEqual(original);
    expect(result.memory?.search).toMatchObject({
      provider: "remote-b",
      model: "new-model",
      remote: { apiKey: "new-owner-key" },
    });
    const pinned = result.agents?.entries?.worker?.memory?.search;
    expect(pinned).toMatchObject({
      provider: "remote-a",
      model: "previous-model",
      remote: {
        baseUrl: search.remote?.baseUrl ?? "https://shared.example/v1",
        apiKey: search.remote?.apiKey ?? secretRef("PREVIOUS_EMBED_KEY"),
        headers: search.remote?.headers ?? { "X-Owner": "previous" },
      },
    });
    expect(pinned?.enabled).toBe(search.enabled);
    expect(result.agents?.entries?.plain).toEqual({});
    expect(resolveMemorySearchConfig(result, "plain")).toMatchObject({
      provider: "remote-b",
      remote: { apiKey: "new-owner-key" },
    });
    if (search.enabled !== false) {
      expect(resolveMemorySearchConfig(result, "worker")).toMatchObject({
        provider: "remote-a",
        model: "previous-model",
        remote: pinned?.remote,
      });
    }
  },
);

it.each([false, true])(
  "does not mutate agent overrides when a provider switch is not saved (probe failure: %s)",
  async (failProbe) => {
    mocks.get.mockImplementation((id) =>
      adapter(id, embeddingProvider({ embed: vi.fn(async () => (failProbe ? [] : [0.1])) })),
    );
    const config: OpenClawConfig = {
      ...memoryConfig({ provider: "remote-a", remote: { apiKey: secretRef("OLD_KEY") } }),
      agents: { entries: { worker: { memory: { search: { remote: { apiKey: "agent-key" } } } } } },
    };
    const original = structuredClone(config);
    expect(
      await runMemorySetupFlow(
        config,
        prompter({ confirms: [true, false], selects: ["remote-b", "existing"] }),
      ),
    ).toBe(config);
    expect(config).toEqual(original);
  },
);

it("does not acquire the new shared key at an agent's previously unauthenticated router", async () => {
  const config: OpenClawConfig = {
    ...memoryConfig({
      provider: "remote-a",
      remote: { apiKey: "***", headers: { Authorization: "***" } },
    }),
    agents: {
      entries: {
        worker: {
          memory: {
            search: { provider: "remote-b", remote: { baseUrl: "https://agent.example/v1" } },
          },
        },
      },
    },
  };
  const before = resolveMemorySearchConfig(config, "worker");
  expect(before?.remote?.apiKey).toBeUndefined();
  const result = await runMemorySetupFlow(
    config,
    prompter({ selects: ["remote-b", "key"], texts: ["new-model", "new-owner-key"] }),
  );
  expect(result).not.toBe(config);
  // Persist/reload the real candidate: undefined fields cannot protect against inheritance.
  // eslint-disable-next-line unicorn/prefer-structured-clone -- Exercise JSON persistence, not an in-memory clone.
  const reloaded: OpenClawConfig = JSON.parse(JSON.stringify(result));
  expect(resolveMemorySearchConfig(reloaded, "worker")).toMatchObject({
    provider: "remote-b",
    model: "embed-default",
    remote: { baseUrl: "https://agent.example/v1", apiKey: "", headers: {} },
  });
});

it("pins the previous adapter default model and absence of a remote endpoint", async () => {
  const config: OpenClawConfig = {
    ...memoryConfig({ provider: "remote-a" }),
    agents: { entries: { worker: { memory: { search: { remote: { apiKey: "***" } } } } } },
  };
  const result = await runMemorySetupFlow(
    config,
    prompter({ selects: ["remote-b", "key"], texts: ["new-model", "new-owner-key"] }),
  );
  expect(result).not.toBe(config);
  expect(resolveMemorySearchConfig(result, "worker")).toMatchObject({
    provider: "remote-a",
    model: "embed-default",
    remote: { baseUrl: "", apiKey: "***", headers: {} },
  });
});
