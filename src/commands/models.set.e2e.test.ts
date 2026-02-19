import { beforeEach, describe, expect, it, vi } from "vitest";

const readConfigFileSnapshot = vi.fn();
const writeConfigFile = vi.fn().mockResolvedValue(undefined);
const loadConfig = vi.fn().mockReturnValue({});

vi.mock("../config/config.js", () => ({
  CONFIG_PATH: "/tmp/openclaw.json",
  readConfigFileSnapshot,
  writeConfigFile,
  loadConfig,
}));

function mockConfigSnapshot(config: Record<string, unknown> = {}) {
  readConfigFileSnapshot.mockResolvedValue({
    path: "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: {},
    valid: true,
    config,
    issues: [],
    legacyIssues: [],
  });
}

function makeRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

function getWrittenConfig() {
  return writeConfigFile.mock.calls[0]?.[0] as Record<string, unknown>;
}

function expectWrittenPrimaryModel(model: string) {
  expect(writeConfigFile).toHaveBeenCalledTimes(1);
  const written = getWrittenConfig();
  expect(written.agents).toEqual({
    defaults: {
      model: { primary: model },
      models: { [model]: {} },
    },
  });
}

describe("models set + fallbacks", () => {
  beforeEach(() => {
    readConfigFileSnapshot.mockReset();
    writeConfigFile.mockClear();
  });

  it("normalizes z.ai provider in models set", async () => {
    mockConfigSnapshot({});
    const runtime = makeRuntime();
    const { modelsSetCommand } = await import("./models/set.js");

    await modelsSetCommand("z.ai/glm-4.7", runtime);

    expectWrittenPrimaryModel("zai/glm-4.7");
  });

  it("normalizes z-ai provider in models fallbacks add", async () => {
    mockConfigSnapshot({ agents: { defaults: { model: { fallbacks: [] } } } });
    const runtime = makeRuntime();
    const { modelsFallbacksAddCommand } = await import("./models/fallbacks.js");

    await modelsFallbacksAddCommand("z-ai/glm-4.7", runtime);

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    const written = getWrittenConfig();
    expect(written.agents).toEqual({
      defaults: {
        model: { fallbacks: ["zai/glm-4.7"] },
        models: { "zai/glm-4.7": {} },
      },
    });
  });

  it("normalizes provider casing in models set", async () => {
    mockConfigSnapshot({});
    const runtime = makeRuntime();
    const { modelsSetCommand } = await import("./models/set.js");

    await modelsSetCommand("Z.AI/glm-4.7", runtime);

    expectWrittenPrimaryModel("zai/glm-4.7");
  });
});
