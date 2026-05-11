import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { runExperimental } from "./experimental.js";

const mocks = vi.hoisted(() => ({
  createClackPrompter: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(),
  prompter: {
    intro: vi.fn(),
    multiselect: vi.fn(),
    note: vi.fn(),
    outro: vi.fn(),
  },
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: (...args: unknown[]) => mocks.readConfigFileSnapshot(...args),
  replaceConfigFile: (...args: unknown[]) => mocks.replaceConfigFile(...args),
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
    mocks.replaceConfigFile.mockReset();
    mocks.prompter.intro.mockReset();
    mocks.prompter.multiselect.mockReset();
    mocks.prompter.note.mockReset();
    mocks.prompter.outro.mockReset();
    mocks.createClackPrompter.mockReturnValue(mocks.prompter);
  });

  it("shows the schema-derived experimental subset in the picker", async () => {
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
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
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

    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    const replaceParams = mocks.replaceConfigFile.mock.calls[0]?.[0];
    expect(replaceParams.baseHash).toBe("config-1");
    expect(replaceParams.nextConfig).toEqual({
      agents: { defaults: { experimental: { localModelLean: true } } },
      tools: { experimental: { planTool: true } },
    });
  });
});
