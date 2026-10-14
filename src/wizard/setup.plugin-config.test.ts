import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginConfigUiHint } from "../plugins/types.js";
import { createNonExitingRuntime } from "../runtime.js";
import type { WizardMultiSelectParams, WizardPrompter } from "./prompts.js";
import { setupPluginConfig } from "./setup.plugin-config.js";

const loadPluginManifestRegistryCore = vi.fn();
vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: () => loadPluginManifestRegistryCore(),
}));

function makeManifestPlugin(
  id: string,
  uiHints?: Record<string, PluginConfigUiHint>,
  configSchema?: Record<string, unknown>,
) {
  return {
    id,
    name: id,
    configUiHints: uiHints,
    configSchema,
    enabled: true,
    enabledByDefault: true,
  };
}

function pluginConfig(config?: Record<string, unknown>): OpenClawConfig {
  return { plugins: { entries: { fixture: { enabled: true, config } } } };
}

function prompter(overrides: Partial<WizardPrompter> = {}) {
  return createWizardPrompter({
    multiselect: async ({ options }) =>
      options.filter((option) => option.value === "fixture").map((option) => option.value),
    text: vi.fn(async () => "configured"),
    ...overrides,
  });
}

function manifest(hints: Record<string, PluginConfigUiHint>, schema?: Record<string, unknown>) {
  loadPluginManifestRegistryCore.mockReturnValue({
    plugins: [makeManifestPlugin("fixture", hints, schema)],
  });
}

describe("plugin configuration discovery", () => {
  it("offers sorted plugins and prompts only for their non-advanced fields", async () => {
    loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        makeManifestPlugin("zeta", { mode: { label: "Mode" }, gpu: { advanced: true } }),
        makeManifestPlugin("bare"),
        makeManifestPlugin("advanced", { gpu: { advanced: true } }),
        makeManifestPlugin("alpha", { endpoint: { label: "Endpoint" } }),
      ],
    });
    const prompts = prompter({
      multiselect: async ({ options }) => {
        expect(options.map(({ value }) => value)).toEqual(["__skip__", "alpha", "zeta"]);
        return options.filter(({ value }) => value !== "__skip__").map(({ value }) => value);
      },
    });
    const result = await setupPluginConfig({ config: {}, prompter: prompts });
    expect(vi.mocked(prompts.text).mock.calls.map(([params]) => params.message)).toEqual([
      "Endpoint",
      "Mode",
    ]);
    expect(result.plugins?.entries).toEqual({
      alpha: { config: { endpoint: "configured" } },
      zeta: { config: { mode: "configured" } },
    });
  });

  it("offers missing and empty fields while recognizing configured nested paths", async () => {
    loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        makeManifestPlugin("partial", { mode: {}, gateway: {} }),
        makeManifestPlugin("empty", { endpoint: {} }),
        makeManifestPlugin("nested", { "webSearch.mode": {} }),
      ],
    });
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          partial: { config: { mode: "mirror" } },
          empty: { config: { endpoint: "" } },
          nested: { config: { webSearch: { mode: "llm-context" } } },
        },
      },
    };
    let offeredPlugins: unknown[] = [];
    const prompts = prompter({
      multiselect: async ({ options }) => {
        offeredPlugins = options.map(({ value }) => value);
        return [];
      },
    });
    expect(await setupPluginConfig({ config, prompter: prompts })).toBe(config);
    expect(offeredPlugins).toEqual(["__skip__", "empty", "partial"]);
  });
});

describe("setupPluginConfig", () => {
  it("allows skipping plugin setup without prompting for fields", async () => {
    manifest({ enabled: { label: "Enable pairing" } });
    const config = pluginConfig();
    const prompts = prompter({
      multiselect: async ({ options }) =>
        options.filter((option) => option.value === "__skip__").map((option) => option.value),
    });
    const result = await setupPluginConfig({ config, prompter: prompts });
    expect(result).toBe(config);
    expect(prompts.note).not.toHaveBeenCalled();
    expect(prompts.select).not.toHaveBeenCalled();
    expect(prompts.text).not.toHaveBeenCalled();
    expect(prompts.confirm).not.toHaveBeenCalled();
  });

  it("preserves typed enum values when writing a nested uiHint path", async () => {
    manifest(
      { "webSearch.mode": { label: "Mode" } },
      {
        type: "object",
        properties: {
          webSearch: {
            type: "object",
            properties: { mode: { enum: [1, "1", { mode: "second" }] } },
          },
        },
      },
    );
    const prompts = prompter();
    vi.mocked(prompts.select).mockImplementation(async ({ options }) => options[2]!.value);
    const result = await setupPluginConfig({ config: pluginConfig(), prompter: prompts });
    expect(prompts.select).toHaveBeenCalledWith({
      message: "Mode",
      options: [
        { value: "0", label: "1" },
        { value: "1", label: '"1"' },
        { value: "2", label: '{"mode":"second"}' },
      ],
      initialValue: undefined,
    });
    expect(result.plugins?.entries?.fixture?.config).toEqual({
      webSearch: { mode: { mode: "second" } },
    });
    expect(result.plugins?.entries?.fixture?.config?.["webSearch.mode"]).toBeUndefined();
  });

  it.each([
    {
      name: "an existing array through a dotted index",
      field: "accounts.0.token",
      existing: { accounts: [{}] },
      expected: { accounts: [{ token: "configured" }] },
    },
    {
      name: "a missing schema-declared array through a dotted index",
      field: "accounts.0.token",
      schema: {
        type: "object",
        properties: {
          accounts: {
            type: "array",
            items: { type: "object", properties: { token: { type: "string" } } },
          },
        },
      },
      expected: { accounts: [{ token: "configured" }] },
    },
    {
      name: "a numeric record key through a dotted path",
      field: "accounts.0.token",
      schema: {
        type: "object",
        properties: {
          accounts: {
            type: "object",
            properties: { "0": { type: "object", properties: { token: { type: "string" } } } },
          },
        },
      },
      expected: { accounts: { "0": { token: "configured" } } },
    },
    {
      name: "an explicit bracketed array index without a schema",
      field: "accounts[0].token",
      expected: { accounts: [{ token: "configured" }] },
    },
  ])("writes $name", async ({ field, existing, schema, expected }) => {
    manifest({ [field]: { label: "Token" } }, schema);
    const result = await setupPluginConfig({
      config: pluginConfig(existing),
      prompter: prompter(),
    });
    expect(result.plugins?.entries?.fixture?.config).toEqual(expected);
  });

  it("rejects prototype-polluting paths without mutating config", async () => {
    const pollutionProbe = "openclawPluginPollutionProbe";
    manifest({ [`safe.__proto__.${pollutionProbe}`]: { label: "Unsafe field" } });
    const config = pluginConfig();
    await expect(setupPluginConfig({ config, prompter: prompter() })).rejects.toThrow(
      /Invalid path segment/,
    );
    expect(config.plugins?.entries?.fixture?.config).toBeUndefined();
    expect(Object.hasOwn(Object.prototype, pollutionProbe)).toBe(false);
  });

  it("coerces only JSON-compatible numeric inputs", async () => {
    manifest(
      {
        decimal: { label: "Decimal" },
        scientific: { label: "Scientific" },
        retries: { label: "Retries" },
        hexadecimal: { label: "Hexadecimal" },
        fractionalRetries: { label: "Fractional retries" },
      },
      {
        type: "object",
        properties: {
          decimal: { type: "number" },
          scientific: { type: "number" },
          retries: { type: "integer" },
          hexadecimal: { type: "number" },
          fractionalRetries: { type: "integer" },
        },
      },
    );
    const answers = ["1.5", "1e2", "3", "0x10", "1.5"];
    const result = await setupPluginConfig({
      config: pluginConfig(),
      prompter: prompter({ text: vi.fn(async () => answers.shift() ?? "") }),
    });
    expect(result.plugins?.entries?.fixture?.config).toEqual({
      decimal: 1.5,
      scientific: 100,
      retries: 3,
    });
  });
});

const ensureOnboardingPluginInstalled = vi.hoisted(() =>
  vi.fn(async ({ cfg }: { cfg: Record<string, unknown> }) => ({
    cfg,
    installed: true,
    status: "installed",
  })),
);
vi.mock("../commands/onboarding-plugin-install.js", () => ({ ensureOnboardingPluginInstalled }));
import { setupOfficialPluginInstalls } from "./setup.official-plugins.js";

it("offers only unconfigured generic plugins and installs the selected plugin", async () => {
  const installPrompter = createWizardPrompter({
    multiselect: async <T>(params: WizardMultiSelectParams<T>): Promise<T[]> => {
      const ids = params.options.map(({ value }) => value);
      expect(ids).not.toContain("acpx");
      expect(ids).not.toContain("diagnostics-otel");
      expect(ids).not.toContain("brave");
      expect(ids).not.toContain("codex");
      expect(ids).not.toContain("discord");
      return params.options
        .filter(({ value }) => value === "__skip__" || value === "diagnostics-prometheus")
        .map(({ value }) => value);
    },
  });
  const config = {
    plugins: {
      entries: { acpx: { enabled: true } },
      installs: {
        "diagnostics-otel": { source: "npm" as const, spec: "@openclaw/diagnostics-otel" },
      },
    },
  };
  const runtime = createNonExitingRuntime();
  await setupOfficialPluginInstalls({
    config,
    prompter: installPrompter,
    runtime,
    workspaceDir: "/tmp/workspace",
  });
  expect(ensureOnboardingPluginInstalled).toHaveBeenCalledExactlyOnceWith({
    cfg: config,
    prompter: installPrompter,
    runtime,
    workspaceDir: "/tmp/workspace",
    promptInstall: false,
    entry: expect.objectContaining({
      pluginId: "diagnostics-prometheus",
      trustedSourceLinkedOfficialInstall: true,
      install: expect.objectContaining({ npmSpec: "@openclaw/diagnostics-prometheus" }),
    }),
  });
});
