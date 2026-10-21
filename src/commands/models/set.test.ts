import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, TransformConfigFileParams } from "../../config/config.js";
import { createTestRuntime } from "../test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  logConfigUpdated: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  repairModelSelectionRuntimePlugins: vi.fn(),
  replaceConfigFile: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: (...args: unknown[]) => mocks.readConfigFileSnapshot(...args),
  transformConfigFile: async ({ transform }: TransformConfigFileParams<unknown>) => {
    const loaded = await mocks.readConfigFileSnapshot();
    const snapshot = {
      path: "/tmp/openclaw.json",
      parsed: loaded.sourceConfig ?? loaded.config,
      runtimeConfig: loaded.config,
      ...loaded,
    };
    const { nextConfig, result } = await transform(
      snapshot.sourceConfig ?? snapshot.config,
      { snapshot, previousHash: snapshot.hash ?? null, attempt: 0 },
      {},
    );
    await mocks.replaceConfigFile({ sourceConfig: nextConfig, baseHash: snapshot.hash });
    return { nextConfig, result };
  },
}));

vi.mock("../../config/logging.js", () => ({
  logConfigUpdated: (...args: unknown[]) => mocks.logConfigUpdated(...args),
}));

// Real provider activation is covered by model-selection.runtime.test.ts.
vi.mock("./model-selection.runtime.js", () => ({
  withModelCommandProviderRuntime: (_params: unknown, run: () => unknown) => run(),
}));

vi.mock("../runtime-plugin-install.js", () => ({
  repairModelSelectionRuntimePlugins: mocks.repairModelSelectionRuntimePlugins,
}));

import { modelsSetCommand } from "./set.js";

type ModelEntries = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["models"];

function configWithModels(models: ModelEntries): OpenClawConfig {
  return { agents: { defaults: { models: structuredClone(models) } } };
}

function mockSnapshot(sourceConfig: OpenClawConfig, runtimeConfig = sourceConfig) {
  mocks.readConfigFileSnapshot.mockResolvedValue({
    valid: true,
    hash: "config-hash",
    sourceConfig,
    runtimeConfig,
    config: runtimeConfig,
  });
}

async function expectSelection(input: string, primary: string, models: ModelEntries) {
  const runtime = createTestRuntime();
  await modelsSetCommand(input, runtime);
  expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
  const [replaceParams] = mocks.replaceConfigFile.mock.calls[0] ?? [];
  expect(replaceParams?.sourceConfig.agents?.defaults).toEqual({ model: { primary }, models });
  expect(mocks.repairModelSelectionRuntimePlugins).toHaveBeenCalledWith({
    cfg: replaceParams?.sourceConfig,
    model: primary,
  });
  expect(runtime.log).toHaveBeenCalledWith(`Default model: ${primary}`);
}

describe("modelsSetCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.replaceConfigFile.mockResolvedValue(undefined);
    mocks.repairModelSelectionRuntimePlugins.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves aliases from runtime config while writing only source config", async () => {
    const models = { "anthropic/claude-sonnet-4-6": {} };
    mockSnapshot(
      configWithModels(models),
      configWithModels({
        "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
      }),
    );
    await expectSelection("sonnet", "anthropic/claude-sonnet-4-6", models);
  });

  it("keeps authored aliases ahead of runtime-only aliases", async () => {
    const models = { "openai/gpt-5.5": { alias: "sonnet" } };
    mockSnapshot(
      configWithModels(models),
      configWithModels({
        ...models,
        "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
      }),
    );
    await expectSelection("sonnet", "openai/gpt-5.5", models);
  });

  it("persists manifest-owned provider aliases with the canonical provider id", async () => {
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.resolve("extensions"));

    mockSnapshot(configWithModels({}));
    await expectSelection("z.ai/glm-4.7", "zai/glm-4.7", { "zai/glm-4.7": {} });
  });
});
