import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { runExperimental } from "./experimental.js";

type TransformConfigFileWithRetryParams = {
  transform: (currentConfig: Record<string, unknown>) => {
    nextConfig: unknown;
    result?: unknown;
  };
};

const mocks = vi.hoisted(() => ({
  createClackPrompter: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  transformConfigFileWithRetry: vi.fn(),
  validateConfigObjectWithPlugins: vi.fn(),
  prompter: {
    intro: vi.fn(),
    multiselect: vi.fn(),
    note: vi.fn(),
    outro: vi.fn(),
  },
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: (...args: unknown[]) => mocks.readConfigFileSnapshot(...args),
  transformConfigFileWithRetry: (...args: unknown[]) => mocks.transformConfigFileWithRetry(...args),
  validateConfigObjectWithPlugins: (...args: unknown[]) =>
    mocks.validateConfigObjectWithPlugins(...args),
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: (...args: unknown[]) => mocks.createClackPrompter(...args),
}));

function makeRuntime(): RuntimeEnv {
  return {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
  } as unknown as RuntimeEnv;
}

describe("runExperimental", () => {
  beforeEach(() => {
    mocks.createClackPrompter.mockReset();
    mocks.readConfigFileSnapshot.mockReset();
    mocks.transformConfigFileWithRetry.mockReset();
    mocks.validateConfigObjectWithPlugins.mockReset();
    mocks.prompter.intro.mockReset();
    mocks.prompter.multiselect.mockReset();
    mocks.prompter.note.mockReset();
    mocks.prompter.outro.mockReset();
    mocks.createClackPrompter.mockReturnValue(mocks.prompter);
    mocks.validateConfigObjectWithPlugins.mockImplementation((config: unknown) => ({
      ok: true,
      config,
      issues: [],
    }));
    mocks.transformConfigFileWithRetry.mockImplementation(
      async (params: TransformConfigFileWithRetryParams) => {
        const snapshot = await mocks.readConfigFileSnapshot();
        const transformed = params.transform(snapshot.config ?? {});
        return { result: transformed.result, nextConfig: transformed.nextConfig };
      },
    );
  });

  it("shows the schema-derived experimental subset and persists absent unchecked flags", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      hash: "config-1",
      resolved: {
        tools: { experimental: { planTool: true } },
      },
      config: {},
    });
    mocks.prompter.multiselect.mockResolvedValue(["tools.experimental.planTool"]);

    await runExperimental(makeRuntime());

    expect(mocks.prompter.multiselect).toHaveBeenCalledOnce();
    const prompt = mocks.prompter.multiselect.mock.calls[0]?.[0];
    expect(prompt.options.map((option: { value: string }) => option.value)).toEqual([
      "agents.defaults.experimental.localModelLean",
      "agents.defaults.memorySearch.experimental.sessionMemory",
      "tools.experimental.planTool",
    ]);
    expect(prompt.options.map((option: { label: string }) => option.label)).toContain(
      "Enable Structured Plan Tool",
    );
    expect(mocks.transformConfigFileWithRetry).toHaveBeenCalledOnce();
    expect(mocks.validateConfigObjectWithPlugins.mock.calls[0]?.[0]).toEqual({
      agents: {
        defaults: {
          experimental: { localModelLean: false },
          memorySearch: { experimental: { sessionMemory: false } },
        },
      },
      tools: { experimental: { planTool: true } },
    });
  });

  it("writes only changed experimental booleans onto the resolved source config", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      hash: "config-1",
      resolved: {
        tools: { experimental: { planTool: true } },
      },
      config: {
        runtimeDefaultOnly: true,
      },
    });
    mocks.prompter.multiselect.mockResolvedValue([
      "agents.defaults.experimental.localModelLean",
      "tools.experimental.planTool",
    ]);

    await runExperimental(makeRuntime());

    expect(mocks.transformConfigFileWithRetry).toHaveBeenCalledOnce();
    const transformParams = mocks.transformConfigFileWithRetry.mock.calls[0]?.[0];
    expect(transformParams.base).toBe("source");
    expect(mocks.validateConfigObjectWithPlugins.mock.calls[0]?.[0]).toEqual({
      runtimeDefaultOnly: true,
      agents: {
        defaults: {
          experimental: { localModelLean: true },
          memorySearch: { experimental: { sessionMemory: false } },
        },
      },
      tools: { experimental: { planTool: true } },
    });
  });
});
