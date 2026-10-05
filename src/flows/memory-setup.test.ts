import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  EmbeddingProviderAdapter,
  EmbeddingProvider,
  EmbeddingProviderCreateResult,
} from "../plugins/embedding-provider-types.js";
import type { MemoryEmbeddingProviderAdapter } from "../plugins/memory-embedding-providers.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { runMemorySetupFlow } from "./memory-setup.js";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(() => ({ index: { plugins: [] }, plugins: [] })),
  manifestIds: vi.fn(() => ["remote-a", "remote-b", "local"]),
  registered: vi.fn(() => [] as Array<{ adapter: EmbeddingProviderAdapter }>),
  alias: vi.fn(() => undefined as string | undefined),
  get: vi.fn((_id: string) => undefined as EmbeddingProviderAdapter | undefined),
  promptRef: vi.fn(),
  resolveRef: vi.fn(),
  resolveCommand: vi.fn(),
}));

vi.mock("../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestContractSnapshot: mocks.snapshot,
  listAvailableManifestContractValues: mocks.manifestIds,
}));
vi.mock("../plugins/embedding-providers.js", () => ({
  listRegisteredEmbeddingProviders: mocks.registered,
}));
vi.mock("../plugins/embedding-provider-config.js", () => ({
  resolveConfiguredGenericEmbeddingProviderId: mocks.alias,
}));
vi.mock("../plugins/embedding-provider-runtime.js", () => ({ getEmbeddingProvider: mocks.get }));
vi.mock("../plugins/provider-auth-ref.js", () => ({ promptSecretRefForSetup: mocks.promptRef }));
vi.mock("../wizard/setup.secret-input.js", () => ({
  resolveSetupSecretInputString: mocks.resolveRef,
}));
vi.mock("../cli/command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets: mocks.resolveCommand,
}));
vi.mock("../cli/command-secret-targets.js", () => ({
  getMemoryEmbeddingCommandSecretTargetIds: () => new Set(["models.providers.*.apiKey"]),
}));

function adapter(id = "remote-a", provider?: EmbeddingProvider): MemoryEmbeddingProviderAdapter {
  return {
    id,
    defaultModel: "embed-default",
    transport: "remote",
    authProviderId: id,
    create: vi.fn(async () => ({
      provider: provider ?? {
        id,
        model: "embed-default",
        embed: vi.fn(async () => [0.1, 0.2]),
        embedBatch: vi.fn(async () => [[0.1, 0.2]]),
        close: vi.fn(async () => {}),
      },
    })),
  };
}

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
  mocks.registered.mockReturnValue([]);
  mocks.resolveCommand.mockImplementation(async ({ config }: { config: OpenClawConfig }) => ({
    effectiveConfig: config,
  }));
});
afterEach(() => vi.useRealTimers());

describe("memory setup", () => {
  it.each([
    { selected: "openai", model: "text-embedding-3-small", fallback: "none" as const },
    { selected: "gemini", model: "gemini-embedding-001", fallback: "none" as const },
    { selected: "gemini", model: "gemini-embedding-2-preview", fallback: "openai" as const },
  ])(
    "preserves multimodal config for incompatible $selected/$model/$fallback",
    async ({ selected, model, fallback }) => {
      const chosen = adapter(selected);
      chosen.supportsMultimodalEmbeddings = ({ model: candidateModel }) =>
        selected === "gemini" && candidateModel === "gemini-embedding-2-preview";
      mocks.get.mockReturnValue(chosen);
      const config: OpenClawConfig = {
        memory: {
          search: {
            provider: "gemini",
            model: "gemini-embedding-2-preview",
            fallback,
            multimodal: { enabled: true, modalities: ["image"] },
            query: { maxResults: 7 },
          },
        },
        agents: { entries: { main: { memory: { search: { enabled: false } } } } },
      };
      const original = structuredClone(config);
      const prompt = prompter({ selects: [selected, "existing"], texts: [model] });
      const result = await runMemorySetupFlow(config, prompt);
      expect(result).toBe(config);
      expect(config).toEqual(original);
      expect(chosen.create).not.toHaveBeenCalled();
      expect(prompt.confirm).toHaveBeenCalledOnce();
      expect(prompt.note).toHaveBeenCalledWith(
        expect.stringContaining("compatible"),
        "Memory setup unchanged",
      );
    },
  );

  it("saves compatible multimodal defaults without changing per-agent overrides", async () => {
    const chosen = adapter("gemini");
    chosen.supportsMultimodalEmbeddings = ({ model }) => model === "gemini-embedding-2-preview";
    mocks.get.mockReturnValue(chosen);
    const config: OpenClawConfig = {
      memory: {
        search: {
          enabled: false,
          provider: "gemini",
          model: "gemini-embedding-2-preview",
          fallback: "none",
          multimodal: { enabled: true, modalities: ["image"] },
          query: { maxResults: 7 },
        },
      },
      agents: { entries: { main: { memory: { search: { enabled: false } } } } },
    };
    const original = structuredClone(config);
    const result = await runMemorySetupFlow(
      config,
      prompter({ selects: ["gemini", "existing"], texts: ["gemini-embedding-2-preview"] }),
    );
    expect(result).not.toBe(config);
    expect(config).toEqual(original);
    expect(result.agents).toBe(config.agents);
    expect(resolveMemorySearchConfig({ ...result, agents: undefined }, "main")).toMatchObject({
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      multimodal: { enabled: true, modalities: ["image"] },
      query: { maxResults: 7 },
    });
    expect(chosen.create).toHaveBeenCalledOnce();
  });

  it("does not reintroduce a registered provider excluded by manifest policy", async () => {
    mocks.registered.mockReturnValue([{ adapter: adapter("disabled-remote") }]);
    mocks.manifestIds.mockReturnValue(["remote-a"]);
    const prompt = prompter();
    await runMemorySetupFlow({ plugins: { entries: { disabled: { enabled: false } } } }, prompt);
    expect(prompt.select).toHaveBeenCalledWith(
      expect.objectContaining({ options: [{ value: "remote-a", label: "remote-a" }] }),
    );
    expect(mocks.registered).not.toHaveBeenCalled();
  });

  it("skips before catalog or provider runtime access and preserves identity", async () => {
    const config: OpenClawConfig = { memory: { search: { enabled: false } } };
    const result = await runMemorySetupFlow(config, prompter({ confirms: [false] }));
    expect(result).toBe(config);
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("probes one selected provider without indexing, closes it, and preserves unrelated settings", async () => {
    const close = vi.fn(async () => {});
    const embed = vi.fn(async () => [1, 0]);
    const chosen = adapter("remote-a", {
      id: "remote-a",
      model: "embed-default",
      embed,
      embedBatch: vi.fn(),
      close,
    });
    mocks.get.mockReturnValue(chosen);
    const config: OpenClawConfig = {
      memory: {
        citations: "on",
        search: {
          enabled: false,
          provider: "remote-a",
          model: "old",
          query: { maxResults: 7 },
          remote: { baseUrl: "https://same.example", batch: { enabled: false } },
        },
      },
      agents: { entries: { worker: { memory: { search: { provider: "remote-b" } } } } },
    };
    const result = await runMemorySetupFlow(config, prompter({ texts: ["embed-default"] }));
    expect(result).not.toBe(config);
    expect(result.memory?.search).toMatchObject({
      enabled: true,
      provider: "remote-a",
      model: "embed-default",
      query: { maxResults: 7 },
      remote: { baseUrl: "https://same.example", batch: { enabled: false } },
    });
    expect(result.agents).toBe(config.agents);
    expect(chosen.create).toHaveBeenCalledOnce();
    expect(embed).toHaveBeenCalledWith(
      "ping",
      expect.objectContaining({ inputType: "query", signal: expect.any(AbortSignal) }),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("persists a SecretRef but passes only its resolved value to the probe", async () => {
    const ref = { source: "env" as const, provider: "default", id: "EMBED_KEY" };
    mocks.promptRef.mockResolvedValue({ ref, resolvedValue: "probe-secret" });
    mocks.resolveRef.mockResolvedValue("probe-secret");
    const chosen = adapter();
    mocks.get.mockReturnValue(chosen);
    const result = await runMemorySetupFlow({}, prompter({ selects: ["remote-a", "ref"] }));
    expect(result.memory?.search?.remote?.apiKey).toEqual(ref);
    expect(chosen.create).toHaveBeenCalledWith(
      expect.objectContaining({ remote: { apiKey: "probe-secret" } }),
    );
    expect(mocks.resolveRef).not.toHaveBeenCalled();
  });

  it("lists enabled manifest remotes without selecting or activating local providers", async () => {
    const prompts = prompter({ confirms: [true, false] });
    await runMemorySetupFlow({}, prompts);
    expect(
      vi.mocked(prompts.select).mock.calls[0]?.[0].options.map((entry) => entry.value),
    ).toEqual(["remote-a", "remote-b"]);
    expect(mocks.get).toHaveBeenCalledWith("remote-a", expect.any(Object));
  });

  it("masks entered keys and keeps the probe credential separate from saved config", async () => {
    const prompts = prompter({
      selects: ["remote-a", "key"],
      texts: ["embed-default", "typed-key"],
    });
    const result = await runMemorySetupFlow({}, prompts);
    expect(vi.mocked(prompts.text).mock.calls[1]?.[0]).toMatchObject({ sensitive: true });
    expect(result.memory?.search?.remote?.apiKey).toBe("typed-key");
    expect(mocks.get.mock.calls.every(([id]) => id === "remote-a")).toBe(true);
  });

  it("keeps existing credentials as the ref-mode default and offers no plaintext entry", async () => {
    const prompts = prompter();
    const config: OpenClawConfig = {
      memory: { search: { provider: "remote-a", remote: { apiKey: "saved-key" } } },
    };
    await runMemorySetupFlow(config, prompts, { secretInputMode: "ref" });
    const credentialPrompt = vi.mocked(prompts.select).mock.calls[1]?.[0];
    expect(credentialPrompt?.initialValue).toBe("existing");
    expect(credentialPrompt?.options.map((entry) => entry.value)).toEqual(["existing", "ref"]);
  });

  it("preserves an existing same-provider remote ref and resolves it only for the probe", async () => {
    const ref = { source: "env" as const, provider: "default", id: "CURRENT_EMBED_KEY" };
    mocks.resolveRef.mockResolvedValue("current-probe-key");
    const chosen = adapter();
    mocks.get.mockReturnValue(chosen);
    const config: OpenClawConfig = {
      memory: { search: { provider: "remote-a", model: "embed-default", remote: { apiKey: ref } } },
    };
    const result = await runMemorySetupFlow(config, prompter());
    expect(result.memory?.search?.remote?.apiKey).toEqual(ref);
    expect(chosen.create).toHaveBeenCalledWith(
      expect.objectContaining({ remote: { apiKey: "current-probe-key" } }),
    );
  });

  it.each([
    { selected: "remote-a", owner: "remote-a", keyPath: "models.providers.remote-a.apiKey" },
    { selected: "gemini", owner: "google", keyPath: "models.providers.google.apiKey" },
    {
      selected: "tenant.example",
      owner: "tenant.example",
      keyPath: 'models.providers["tenant.example"].apiKey',
    },
  ])("resolves only $owner credentials for $selected", async ({ selected, owner, keyPath }) => {
    const ref = { source: "env" as const, provider: "default", id: "MODEL_EMBED_KEY" };
    const config: OpenClawConfig = {
      models: {
        providers: {
          [owner]: {
            api: "openai-completions",
            baseUrl: "https://remote.example/v1",
            apiKey: ref,
            headers: { "X.Tenant.Key": "${MODEL_EMBED_HEADER}" },
            models: [],
          },
        },
      },
    };
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
        return {
          effectiveConfig: {
            ...draft,
            models: {
              ...draft.models,
              providers: {
                ...draft.models?.providers,
                [owner]: { ...draft.models?.providers?.[owner], apiKey: "probe-only-key" },
              },
            },
          },
        };
      },
    );
    const chosen = { ...adapter(selected), authProviderId: owner };
    mocks.get.mockReturnValue(chosen);
    const result = await runMemorySetupFlow(config, prompter({ selects: [selected, "existing"] }));
    expect(result.models?.providers?.[owner]?.apiKey).toEqual(ref);
    expect(chosen.create).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          models: expect.objectContaining({
            providers: expect.objectContaining({
              [owner]: expect.objectContaining({ apiKey: "probe-only-key" }),
            }),
          }),
        }),
      }),
    );
  });

  it("does not send old destination credentials or headers to a new provider", async () => {
    const chosen = adapter("remote-b");
    mocks.get.mockReturnValue(chosen);
    const config: OpenClawConfig = {
      memory: {
        search: {
          provider: "remote-a",
          model: "old",
          remote: {
            baseUrl: "https://old.example",
            apiKey: "old-secret",
            headers: { Authorization: "old-secret" },
            batch: { enabled: false },
          },
        },
      },
    };
    const result = await runMemorySetupFlow(
      config,
      prompter({ selects: ["remote-b", "existing"] }),
    );
    expect(chosen.create).toHaveBeenCalledWith(
      expect.objectContaining({ remote: { batch: { enabled: false } } }),
    );
    expect(result.memory?.search?.remote).toEqual({ batch: { enabled: false } });
  });

  it("keeps the original config on failed probe, save refusal, and cancellation", async () => {
    const config: OpenClawConfig = {};
    const bad = adapter("remote-a", {
      id: "remote-a",
      model: "embed-default",
      embed: vi.fn(async () => [Number.NaN]),
      embedBatch: vi.fn(),
    });
    mocks.get.mockReturnValue(bad);
    expect(await runMemorySetupFlow(config, prompter())).toBe(config);
    mocks.get.mockReturnValue(adapter());
    expect(await runMemorySetupFlow(config, prompter({ confirms: [true, false] }))).toBe(config);
    const cancelled = prompter();
    vi.mocked(cancelled.text).mockRejectedValueOnce(new WizardCancelledError());
    await expect(runMemorySetupFlow(config, cancelled)).rejects.toBeInstanceOf(
      WizardCancelledError,
    );
  });

  it.each(["create", "embed"])(
    "does not reveal a %s error in a failed readiness note",
    async (phase) => {
      const config: OpenClawConfig = {};
      const secretError = new Error("credential=private-probe-value rejected");
      const chosen = adapter();
      if (phase === "create") {
        chosen.create = vi.fn(async () => {
          throw secretError;
        });
      } else {
        chosen.create = vi.fn(async () => ({
          provider: {
            id: "remote-a",
            model: "embed-default",
            embed: vi.fn(async () => {
              throw secretError;
            }),
            embedBatch: vi.fn(),
            close: vi.fn(async () => {}),
          },
        }));
      }
      mocks.get.mockReturnValue(chosen);
      const prompts = prompter();
      expect(await runMemorySetupFlow(config, prompts)).toBe(config);
      expect(JSON.stringify(vi.mocked(prompts.note).mock.calls)).not.toContain(
        "private-probe-value",
      );
    },
  );

  it("aborts a hanging embedding call and bounds a hanging close", async () => {
    vi.useFakeTimers();
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    let signal: AbortSignal | undefined;
    const provider: EmbeddingProvider = {
      id: "remote-a",
      model: "embed-default",
      embed: vi.fn((_input, options) => {
        signal = options?.signal;
        began();
        return new Promise<number[]>(() => {});
      }),
      embedBatch: vi.fn(async () => []),
      close: vi.fn(() => new Promise<void>(() => {})),
    };
    mocks.get.mockReturnValue(adapter("remote-a", provider));
    const config: OpenClawConfig = {};
    const running = runMemorySetupFlow(config, prompter());
    await started;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await running).toBe(config);
    expect(provider.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out creation and closes a provider created after the deadline", async () => {
    vi.useFakeTimers();
    let finishCreate!: (value: { provider: EmbeddingProvider }) => void;
    let createStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      createStarted = resolve;
    });
    const close = vi.fn(async () => {});
    const late = adapter();
    late.create = vi.fn(
      () =>
        new Promise<EmbeddingProviderCreateResult>((resolve) => {
          finishCreate = resolve;
          createStarted();
        }),
    );
    mocks.get.mockReturnValue(late);
    const config: OpenClawConfig = {};
    const running = runMemorySetupFlow(config, prompter());
    await started;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await running).toBe(config);
    finishCreate({
      provider: {
        id: "remote-a",
        model: "embed-default",
        embed: vi.fn(),
        embedBatch: vi.fn(),
        close,
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
  });
});
