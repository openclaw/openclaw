import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginConfigUiHint } from "../plugins/types.js";
import { createNonExitingRuntime } from "../runtime.js";
import type { WizardMultiSelectParams, WizardPrompter } from "./prompts.js";
import { WizardSession } from "./session.js";
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

const objectSchema = (properties: Record<string, unknown>) => ({ type: "object", properties });
const tokenSchema = objectSchema({ token: { type: "string" } });
const configuredAccount = { accounts: [{ token: "configured" }] };

function configure(config = pluginConfig(), prompts = prompter()) {
  return setupPluginConfig({ config, prompter: prompts });
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
    const result = await configure({}, prompts);
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
    expect(await configure(config, prompts)).toBe(config);
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
    const result = await configure(config, prompts);
    expect(result).toBe(config);
    for (const prompt of [prompts.note, prompts.select, prompts.text, prompts.confirm]) {
      expect(prompt).not.toHaveBeenCalled();
    }
  });

  it("preserves typed enum values when writing a nested uiHint path", async () => {
    manifest(
      { "webSearch.mode": { label: "Mode" } },
      objectSchema({ webSearch: objectSchema({ mode: { enum: [1, "1", { mode: "second" }] } }) }),
    );
    const prompts = prompter();
    vi.mocked(prompts.select).mockImplementation(async ({ options }) => options[2]!.value);
    const result = await configure(pluginConfig(), prompts);
    expect(result.plugins?.entries?.fixture?.config).toEqual({
      webSearch: { mode: { mode: "second" } },
    });
    expect(result.plugins?.entries?.fixture?.config?.["webSearch.mode"]).toBeUndefined();
  });

  it.each([
    ["existing array", { accounts: [{}] }, undefined, configuredAccount],
    [
      "schema array",
      undefined,
      objectSchema({ accounts: { type: "array", items: tokenSchema } }),
      configuredAccount,
    ],
    [
      "numeric record",
      undefined,
      objectSchema({ accounts: objectSchema({ "0": tokenSchema }) }),
      { accounts: { "0": { token: "configured" } } },
    ],
    ["bracket index", undefined, undefined, configuredAccount],
  ] as const)("writes a nested token in %s", async (kind, existing, schema, expected) => {
    const field = kind === "bracket index" ? "accounts[0].token" : "accounts.0.token";
    manifest({ [field]: { label: "Token" } }, schema);
    const result = await configure(pluginConfig(existing));
    expect(result.plugins?.entries?.fixture?.config).toEqual(expected);
  });

  it("rejects prototype-polluting paths without mutating config", async () => {
    const pollutionProbe = "openclawPluginPollutionProbe";
    manifest({ [`safe.__proto__.${pollutionProbe}`]: { label: "Unsafe field" } });
    const config = pluginConfig();
    await expect(configure(config)).rejects.toThrow(/Invalid path segment/);
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
      },
      objectSchema({
        decimal: { type: "number" },
        scientific: { type: "number" },
        retries: { type: "integer" },
        hexadecimal: { type: "number" },
      }),
    );
    let result: OpenClawConfig | undefined;
    const session = new WizardSession(async (prompts) => {
      result = await configure(pluginConfig(), prompts);
    });
    try {
      const selection = (await session.next()).step!;
      await session.answer(selection.id, ["fixture"]);
      const note = (await session.next()).step!;
      await session.answer(note.id, null);
      for (const [invalid, corrected, error] of [
        ["not-a-number", "1.5", "Enter a valid JSON number."],
        ["1e999", "1e2", "Enter a valid JSON number."],
        ["1.5", "3", "Enter a JSON integer."],
        ["0x10", "16", "Enter a valid JSON number."],
      ]) {
        const step = (await session.next()).step!;
        await expect(session.answer(step.id, invalid)).resolves.toBe(error);
        expect((await session.next()).step?.id).toBe(step.id);
        await session.answer(step.id, corrected);
      }
      await session.whenSettled();
      expect(result?.plugins?.entries?.fixture?.config).toEqual({
        decimal: 1.5,
        scientific: 100,
        retries: 3,
        hexadecimal: 16,
      });
    } finally {
      session.cancel();
      await session.whenSettled();
    }
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
      for (const excluded of ["acpx", "diagnostics-otel", "brave", "codex", "discord"]) {
        expect(ids).not.toContain(excluded);
      }
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
