import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { PluginConfigUiHint } from "../plugins/types.js";
import { createNonExitingRuntime } from "../runtime.js";
import type { WizardMultiSelectParams, WizardPrompter } from "./prompts.js";
import { WizardSession } from "./session.js";
import { setupPluginConfig } from "./setup.plugin-config.js";

const loadPluginManifestRegistryCore = vi.fn();
const readBundledDiscoveryModeMock = vi.fn<() => "compat" | "allowlist" | undefined>();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  readBundledDiscoveryModeMock.mockReset();
});
vi.mock("../plugins/bundled-discovery-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/bundled-discovery-state.js")>()),
  readBundledDiscoveryModeMemoized: () => readBundledDiscoveryModeMock(),
}));
vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: () => {
    const { plugins } = loadPluginManifestRegistryCore();
    return {
      plugins,
      manifestRegistry: { plugins, diagnostics: [] },
      discovery: { candidates: [], diagnostics: [] },
    };
  },
}));

function makeManifestPlugin(
  id: string,
  uiHints?: Record<string, PluginConfigUiHint>,
  configSchema?: Record<string, unknown>,
): PluginManifestRecord {
  const rootDir = tempDirs.make("openclaw-plugin-config-");
  return {
    id,
    name: id,
    configUiHints: uiHints,
    configSchema,
    origin: "bundled",
    rootDir,
    source: path.join(rootDir, "index.ts"),
    manifestPath: path.join(rootDir, "openclaw.plugin.json"),
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
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
  it.each<{
    name: string;
    config: OpenClawConfig;
    manifest: Partial<PluginManifestRecord>;
    bundledDiscoveryMode?: "compat" | "allowlist";
    offered: boolean;
  }>([
    {
      name: "explicit disablement over a manifest default",
      config: { plugins: { entries: { fixture: { enabled: false } } } },
      manifest: { providers: ["fixture-provider"] },
      bundledDiscoveryMode: "compat",
      offered: false,
    },
    {
      name: "global disablement",
      config: { plugins: { enabled: false } },
      manifest: { providers: ["fixture-provider"] },
      bundledDiscoveryMode: "compat",
      offered: false,
    },
    {
      name: "deny policy",
      config: { plugins: { deny: ["fixture"] } },
      manifest: {},
      offered: false,
    },
    {
      name: "a restrictive allowlist",
      config: { plugins: { allow: ["other"] } },
      manifest: {},
      offered: false,
    },
    {
      name: "a bundled model provider in compatibility mode",
      config: { plugins: { allow: ["other"] } },
      manifest: { providers: ["fixture-provider"] },
      bundledDiscoveryMode: "compat",
      offered: true,
    },
    {
      name: "a contract-only bundled provider in compatibility mode",
      config: { plugins: { allow: ["other"] } },
      manifest: { contracts: { speechProviders: ["fixture-provider"] } },
      bundledDiscoveryMode: "compat",
      offered: true,
    },
    {
      name: "a contract-only bundled provider in strict allowlist mode",
      config: { plugins: { allow: ["other"] } },
      manifest: { contracts: { speechProviders: ["fixture-provider"] } },
      bundledDiscoveryMode: "allowlist",
      offered: false,
    },
    {
      name: "untrusted workspace origin",
      config: {},
      manifest: { origin: "workspace" },
      offered: false,
    },
    {
      name: "workspace trust before bundled-provider compatibility",
      config: { plugins: { allow: ["other"] } },
      manifest: { origin: "workspace", providers: ["fixture-provider"] },
      bundledDiscoveryMode: "compat",
      offered: false,
    },
    {
      name: "explicitly trusted workspace origin",
      config: { plugins: { allow: ["fixture"] } },
      manifest: { origin: "workspace", enabledByDefault: false },
      offered: true,
    },
    {
      name: "a host-platform default",
      config: {},
      manifest: { enabledByDefault: false, enabledByDefaultOnPlatforms: [process.platform] },
      offered: true,
    },
    {
      name: "an explicitly selected memory slot",
      config: { plugins: { slots: { memory: "fixture" } } },
      manifest: { enabledByDefault: false, kind: "memory" },
      offered: true,
    },
    {
      name: "an explicitly disabled owned channel",
      config: {
        plugins: { entries: { fixture: { enabled: true } } },
        channels: { "fixture-room": { enabled: false } },
      },
      manifest: { channels: ["fixture-room"] },
      offered: false,
    },
    {
      name: "an explicitly enabled owned channel",
      config: { channels: { "fixture-room": { enabled: true } } },
      manifest: { enabledByDefault: false, channels: ["fixture-room"] },
      offered: true,
    },
    {
      name: "configured-provider auto activation",
      config: { agents: { defaults: { model: { primary: "fixture-provider/synthetic-model" } } } },
      manifest: {
        enabledByDefault: false,
        providers: ["fixture-provider"],
        autoEnableWhenConfiguredProviders: ["fixture-provider"],
      },
      offered: true,
    },
    {
      name: "workspace trust before configured-provider auto activation",
      config: { agents: { defaults: { model: { primary: "fixture-provider/synthetic-model" } } } },
      manifest: {
        origin: "workspace",
        enabledByDefault: false,
        providers: ["fixture-provider"],
        autoEnableWhenConfiguredProviders: ["fixture-provider"],
      },
      offered: false,
    },
  ])(
    "uses effective activation for $name",
    async ({ config, manifest: manifestOverrides, bundledDiscoveryMode, offered }) => {
      readBundledDiscoveryModeMock.mockReturnValue(bundledDiscoveryMode);
      loadPluginManifestRegistryCore.mockReturnValue({
        plugins: [{ ...makeManifestPlugin("fixture", { mode: {} }), ...manifestOverrides }],
      });
      const original = structuredClone(config);
      let options: unknown[] = [];
      const prompts = prompter({
        multiselect: async (params) => {
          options = params.options.map(({ value }) => value);
          return [];
        },
      });
      expect(await setupPluginConfig({ config, prompter: prompts })).toBe(config);
      expect(options.includes("fixture")).toBe(offered);
      expect(config).toEqual(original);
    },
  );

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
