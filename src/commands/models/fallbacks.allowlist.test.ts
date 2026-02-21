import { beforeEach, describe, expect, it, vi } from "vitest";

const readConfigFileSnapshot = vi.fn();
const writeConfigFile = vi.fn().mockResolvedValue(undefined);

vi.mock("../../config/config.js", () => ({
  CONFIG_PATH: "/tmp/openclaw.json",
  readConfigFileSnapshot,
  writeConfigFile,
  loadConfig: vi.fn().mockReturnValue({}),
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

function getWrittenModels(): Record<string, unknown> {
  const written = writeConfigFile.mock.calls[0]?.[0] as {
    agents?: { defaults?: { models?: Record<string, unknown> } };
  };
  return written?.agents?.defaults?.models ?? {};
}

describe("modelsFallbacksAddCommand — allowlist safety", () => {
  beforeEach(() => {
    readConfigFileSnapshot.mockReset();
    writeConfigFile.mockClear();
    vi.resetModules();
  });

  it("includes the existing primary model in the allowlist when adding the first fallback", async () => {
    // Regression: adding the first fallback used to create a models allowlist that only
    // contained the fallback model, silently blocking the primary from being used.
    mockConfigSnapshot({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6", fallbacks: [] },
          // No `models` allowlist yet — this is what triggers the bug.
        },
      },
    });

    const { modelsFallbacksAddCommand } = await import("./fallbacks.js");
    await modelsFallbacksAddCommand("openai/gpt-5.2", makeRuntime());

    const models = getWrittenModels();
    // Both the primary AND the new fallback must be in the allowlist.
    expect(models).toMatchObject({
      "anthropic/claude-opus-4-6": {},
      "openai/gpt-5.2": {},
    });
  });

  it("does not add a phantom primary entry when no primary is configured", async () => {
    // Guard: if there's no primary yet, we should not inject an empty/undefined key.
    mockConfigSnapshot({
      agents: {
        defaults: {
          model: { fallbacks: [] },
        },
      },
    });

    const { modelsFallbacksAddCommand } = await import("./fallbacks.js");
    await modelsFallbacksAddCommand("openai/gpt-5.2", makeRuntime());

    const models = getWrittenModels();
    // Only the fallback should appear — no phantom `undefined` key.
    expect(models).toEqual({ "openai/gpt-5.2": {} });
    expect(Object.keys(models)).not.toContain("undefined");
  });

  it("preserves already-correct allowlist when primary is already present", async () => {
    mockConfigSnapshot({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6", fallbacks: [] },
          models: { "anthropic/claude-opus-4-6": {} },
        },
      },
    });

    const { modelsFallbacksAddCommand } = await import("./fallbacks.js");
    await modelsFallbacksAddCommand("openai/gpt-5.2", makeRuntime());

    const models = getWrittenModels();
    expect(models).toMatchObject({
      "anthropic/claude-opus-4-6": {},
      "openai/gpt-5.2": {},
    });
  });
});
