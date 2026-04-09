import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const registerInternalHookMock = vi.fn();
const ensureOpenClawModelsJsonMock = vi.fn<
  (config: unknown, agentDir: unknown) => Promise<{ agentDir: string; wrote: boolean }>
>(async () => ({ agentDir: "/tmp/agent", wrote: false }));
const resolveModelMock = vi.fn<
  (
    provider: unknown,
    modelId: unknown,
    agentDir: unknown,
    cfg: unknown,
    options?: unknown,
  ) => { model: { id: string; provider: string; api: string } }
>(() => ({
  model: {
    id: "gpt-5.4",
    provider: "openai-codex",
    api: "openai-codex-responses",
  },
}));

vi.mock("../hooks/internal-hooks.js", async () => {
  const actual = await vi.importActual<typeof import("../hooks/internal-hooks.js")>(
    "../hooks/internal-hooks.js",
  );
  return {
    ...actual,
    registerInternalHook: (...args: unknown[]) => registerInternalHookMock(...args),
  };
});

vi.mock("../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir: () => "/tmp/agent",
}));

vi.mock("../agents/models-config.js", () => ({
  ensureOpenClawModelsJson: (config: unknown, agentDir: unknown) =>
    ensureOpenClawModelsJsonMock(config, agentDir),
}));

vi.mock("../agents/pi-embedded-runner/model.js", () => ({
  resolveModel: (
    provider: unknown,
    modelId: unknown,
    agentDir: unknown,
    cfg: unknown,
    options?: unknown,
  ) => resolveModelMock(provider, modelId, agentDir, cfg, options),
}));

let prewarmConfiguredPrimaryModel: typeof import("./server-startup.js").__testing.prewarmConfiguredPrimaryModel;
let reRegisterPluginInternalHooks: typeof import("./server-startup.js").__testing.reRegisterPluginInternalHooks;

function createPluginRegistryWithStartupHook(params?: {
  status?: "loaded" | "error";
  registerWhenHooksEnabled?: boolean;
  handler?: ReturnType<typeof vi.fn>;
}) {
  return {
    plugins: [{ id: "memory-core", status: params?.status ?? "loaded" }],
    hooks: [
      {
        pluginId: "memory-core",
        entry: {
          hook: {
            name: "memory-core-short-term-dreaming-cron",
            description: "",
            source: "openclaw-plugin",
            pluginId: "memory-core",
            filePath: "/tmp/memory-core.js",
            baseDir: "/tmp",
            handlerPath: "/tmp/memory-core.js",
          },
          frontmatter: {},
          metadata: { events: ["gateway:startup"] },
          invocation: { enabled: true },
        },
        events: ["gateway:startup"],
        handler: params?.handler ?? vi.fn(),
        registerWhenHooksEnabled: params?.registerWhenHooksEnabled ?? true,
        source: "/tmp/memory-core.js",
      },
    ],
  } as never;
}

describe("gateway startup primary model warmup", () => {
  beforeAll(async () => {
    ({
      __testing: { prewarmConfiguredPrimaryModel, reRegisterPluginInternalHooks },
    } = await import("./server-startup.js"));
  });

  beforeEach(() => {
    ensureOpenClawModelsJsonMock.mockClear();
    resolveModelMock.mockClear();
    registerInternalHookMock.mockClear();
  });

  it("prewarms an explicit configured primary model", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai-codex/gpt-5.4",
          },
        },
      },
    } as OpenClawConfig;

    await prewarmConfiguredPrimaryModel({
      cfg,
      log: { warn: vi.fn() },
    });

    expect(ensureOpenClawModelsJsonMock).toHaveBeenCalledWith(cfg, "/tmp/agent");
    expect(resolveModelMock).toHaveBeenCalledWith("openai-codex", "gpt-5.4", "/tmp/agent", cfg, {
      skipProviderRuntimeHooks: true,
    });
  });

  it("skips warmup when no explicit primary model is configured", async () => {
    await prewarmConfiguredPrimaryModel({
      cfg: {} as OpenClawConfig,
      log: { warn: vi.fn() },
    });

    expect(ensureOpenClawModelsJsonMock).not.toHaveBeenCalled();
    expect(resolveModelMock).not.toHaveBeenCalled();
  });

  it("skips static warmup for configured CLI backends", async () => {
    await prewarmConfiguredPrimaryModel({
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "codex-cli/gpt-5.4",
            },
            cliBackends: {
              "codex-cli": {
                command: "codex",
                args: ["exec"],
              },
            },
          },
        },
      } as OpenClawConfig,
      log: { warn: vi.fn() },
    });

    expect(ensureOpenClawModelsJsonMock).not.toHaveBeenCalled();
    expect(resolveModelMock).not.toHaveBeenCalled();
  });

  it("re-registers plugin internal hooks after clear/load so gateway:startup hooks survive startup reset", () => {
    const handler = vi.fn();
    const restored = reRegisterPluginInternalHooks(
      createPluginRegistryWithStartupHook({ handler }),
      {} as OpenClawConfig,
    );

    expect(restored).toBe(1);
    expect(registerInternalHookMock).toHaveBeenCalledWith("gateway:startup", handler);
  });

  it("skips plugin hooks that were not active at initial registration time", () => {
    const restored = reRegisterPluginInternalHooks(
      createPluginRegistryWithStartupHook({ registerWhenHooksEnabled: false }),
      {} as OpenClawConfig,
    );

    expect(restored).toBe(0);
    expect(registerInternalHookMock).not.toHaveBeenCalled();
  });

  it("skips plugin hook restoration when internal hooks are currently disabled", () => {
    const restored = reRegisterPluginInternalHooks(createPluginRegistryWithStartupHook(), {
      hooks: {
        internal: {
          enabled: false,
        },
      },
    } as OpenClawConfig);

    expect(restored).toBe(0);
    expect(registerInternalHookMock).not.toHaveBeenCalled();
  });

  it("skips plugin hook restoration for plugins that failed to load", () => {
    const restored = reRegisterPluginInternalHooks(
      createPluginRegistryWithStartupHook({ status: "error" }),
      {} as OpenClawConfig,
    );

    expect(restored).toBe(0);
    expect(registerInternalHookMock).not.toHaveBeenCalled();
  });
});
