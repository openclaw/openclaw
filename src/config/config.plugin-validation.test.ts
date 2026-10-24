import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { clearLoadInstalledPluginIndexInstallRecordsCache } from "../plugins/installed-plugin-index-records.js";
import { writePersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store-write.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { shouldSuppressMissingCodexPluginDiagnostics } from "./codex-plugin-diagnostics.js";
import { resolveConfigWidePluginManifestRegistry } from "./io.plugin-metadata.js";
import type { OpenClawConfigWithLegacyRoster } from "./legacy.roster.js";
import { validateConfigObjectWithPlugins as validateConfigObjectWithPluginsRaw } from "./validation.js";

vi.unmock("../version.js");

async function chmodSafeDir(dir: string) {
  if (process.platform === "win32") {
    return;
  }
  await fs.chmod(dir, 0o755);
}

async function mkdirSafe(dir: string) {
  await fs.mkdir(dir, { recursive: true });
  await chmodSafeDir(dir);
}

async function writePluginFixture(params: {
  dir: string;
  id: string;
  schema?: Record<string, unknown>;
  channels?: string[];
}) {
  await mkdirSafe(params.dir);
  await fs.writeFile(
    path.join(params.dir, "index.js"),
    `export default { id: "${params.id}", register() {} };`,
    "utf-8",
  );
  const manifest = {
    id: params.id,
    configSchema: params.schema ?? { type: "object" },
    ...(params.channels ? { channels: params.channels } : {}),
  };
  await fs.writeFile(
    path.join(params.dir, "openclaw.plugin.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
}

async function writeManifestlessClaudeBundleFixture(params: { dir: string }) {
  await mkdirSafe(params.dir);
  await mkdirSafe(path.join(params.dir, "commands"));
  await fs.writeFile(
    path.join(params.dir, "commands", "review.md"),
    "---\ndescription: fixture\n---\n",
    "utf-8",
  );
  await fs.writeFile(path.join(params.dir, "settings.json"), '{"hideThinkingBlock":true}', "utf-8");
}

type Diagnostics = readonly { path: string; message: string }[] | undefined;
type ConfigResult = ReturnType<typeof validateConfigObjectWithPluginsRaw>;

function expectValid(result: ConfigResult): asserts result is ConfigResult & { ok: true } {
  expect(result.ok).toBe(true);
}

function expectInvalid(result: ConfigResult): asserts result is ConfigResult & { ok: false } {
  expect(result.ok).toBe(false);
}

function expectMessage(entries: Diagnostics, pathValue: string, message: string) {
  expect(entries).toContainEqual(expect.objectContaining({ path: pathValue, message }));
}

function expectIncludes(entries: Diagnostics, pathValue: string, fragment: string) {
  expect(
    entries?.some((entry) => entry.path === pathValue && entry.message.includes(fragment)),
  ).toBe(true);
}

function expectNoPath(entries: Diagnostics, pathValue: string) {
  expect(entries?.some((entry) => entry.path === pathValue)).toBe(false);
}
function expectNoMessage(entries: Diagnostics, pattern: RegExp) {
  expect(entries?.some(({ message }) => pattern.test(message))).toBe(false);
}
function expectIssue(result: ConfigResult, pathValue: string, fragment: string) {
  expectInvalid(result);
  expectIncludes(result.issues, pathValue, fragment);
}
const stalePluginMessage = (id: string) =>
  `plugin not found: ${id} (stale config entry ignored; remove it from plugins config)`;
const staleChannelMessage = (id: string) =>
  `unknown channel id: ${id} (stale channel plugin config ignored; run openclaw doctor --fix to remove stale config, or install the plugin)`;
const diagnostic = (fieldPath: string, message: string) => ({ path: fieldPath, message });
const loadedPlugin = (id: string, dir: string) => ({
  enabled: true,
  load: { paths: [dir] },
  entries: { [id]: { enabled: true } },
  allow: [id],
});
const memorySlot = () => ({
  slots: { memory: "memory-lancedb" },
  entries: { "memory-lancedb": { enabled: true } },
});

describe("config plugin validation", () => {
  let fixtureRoot = "";
  let suiteHome = "";
  let googleOverridePluginDir = "";
  let manifestlessClaudeBundleDir = "";
  let blockedPluginDir = "";
  let malformedSchemaPluginDir = "";
  const suiteEnv = () =>
    ({
      HOME: suiteHome,
      OPENCLAW_HOME: undefined,
      OPENCLAW_STATE_DIR: path.join(suiteHome, ".openclaw"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_VERSION: undefined,
      VITEST: "true",
    }) satisfies NodeJS.ProcessEnv;

  const validate = (
    raw: unknown,
    options: Parameters<typeof validateConfigObjectWithPluginsRaw>[1] = {},
  ) => validateConfigObjectWithPluginsRaw(raw, { ...options, env: options.env ?? suiteEnv() });

  const validateCodexConfig = (config: Record<string, unknown>) =>
    validate(
      {
        agents: { entries: { openclaw: {} } },
        plugins: { entries: { codex: { enabled: true, config } } },
      },
      {
        env: {
          ...suiteEnv(),
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(process.cwd(), "extensions"),
        },
      },
    );
  const codexMarketplace = (overrides: Record<string, unknown> = {}) => ({
    marketplaceName: "openai-curated",
    pluginName: "github",
    ...overrides,
  });
  const destructivePolicy = (policy: string, github?: Record<string, unknown>) => ({
    enabled: true,
    allow_destructive_actions: policy,
    plugins: github ? { github: codexMarketplace(github) } : {},
  });

  const writeInstalledRecords = (
    stateDir: string,
    generatedAtMs: number,
    installRecords: Parameters<typeof writePersistedInstalledPluginIndex>[0]["installRecords"],
  ) =>
    writePersistedInstalledPluginIndex(
      {
        version: 1,
        hostContractVersion: "test",
        compatRegistryVersion: "test",
        migrationVersion: 1,
        policyHash: "test",
        generatedAtMs,
        installRecords,
        plugins: [],
        diagnostics: [],
      },
      { stateDir },
    );

  const validateWithRegistry = (
    raw: unknown,
    diagnostics: PluginManifestRegistry["diagnostics"] = [],
  ) =>
    validate(raw, { pluginMetadataSnapshot: { manifestRegistry: { plugins: [], diagnostics } } });

  const validatePluginRefs = (
    plugins: unknown,
    diagnostics?: PluginManifestRegistry["diagnostics"],
  ) => {
    const raw = { agents: { entries: { openclaw: {} } }, plugins };
    return diagnostics ? validateWithRegistry(raw, diagnostics) : validate(raw);
  };

  const installFixture = async (
    id: string,
    options: Omit<Parameters<typeof writePluginFixture>[0], "id" | "dir"> = {},
  ) => {
    const dir = path.join(suiteHome, id);
    await writePluginFixture({ id, dir, ...options });
    return dir;
  };

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-plugin-validation-"));
    await chmodSafeDir(fixtureRoot);
    suiteHome = path.join(fixtureRoot, "home");
    await mkdirSafe(suiteHome);
    googleOverridePluginDir = await installFixture("google", {
      schema: { type: "object", properties: { apiKey: { type: "string" } } },
    });
    manifestlessClaudeBundleDir = path.join(suiteHome, "manifestless-claude-bundle");
    await writeManifestlessClaudeBundleFixture({ dir: manifestlessClaudeBundleDir });
    blockedPluginDir = await installFixture("blocked-plugin");
    malformedSchemaPluginDir = await installFixture("malformed-schema-plugin", {
      schema: { type: "object", properties: { mode: { $ref: "#/$defs/Mode" } } },
    });
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("reports a malformed plugin configSchema as an issue instead of throwing", () => {
    const res = validatePluginRefs(
      loadedPlugin("malformed-schema-plugin", malformedSchemaPluginDir),
    );
    expectIssue(res, "plugins.entries.malformed-schema-plugin.config", "invalid schema");
  });

  it("keeps malformed bundled plugin schemas on the throwing path", () => {
    const bundledRecord = createPluginManifestRecordFixture({
      id: "bundled-schema-plugin",
      configSchema: { type: "object", properties: { mode: { $ref: "#/$defs/Mode" } } },
    });
    expect(() =>
      validate(
        {
          agents: { entries: { openclaw: {} } },
          plugins: { entries: { "bundled-schema-plugin": { enabled: true } } },
        },
        {
          pluginMetadataSnapshot: {
            manifestRegistry: { diagnostics: [], plugins: [bundledRecord] },
          },
        },
      ),
    ).toThrow("invalid schema");
  });

  it("reports missing plugin refs across entries and allowlist surfaces", () => {
    const res = validatePluginRefs({
      enabled: true,
      entries: { "missing-plugin": { enabled: true }, "missing-slot": { enabled: false } },
      allow: ["missing-allow", "missing-slot"],
      deny: ["missing-deny"],
      slots: { memory: "missing-slot" },
    });
    expectInvalid(res);
    expectMessage(res.issues, "plugins.slots.memory", "plugin not found: missing-slot");
    expect(res.warnings.filter((warning) => warning.path.startsWith("plugins."))).toEqual([
      diagnostic("plugins.entries.missing-plugin", stalePluginMessage("missing-plugin")),
      diagnostic("plugins.allow", stalePluginMessage("missing-allow")),
      diagnostic("plugins.deny", stalePluginMessage("missing-deny")),
    ]);
  });

  it.each([
    {
      name: "an exact explicit disable marker",
      pluginId: "missing-plugin",
      entry: { enabled: false },
      warningPaths: [],
    },
    {
      name: "a disabled entry that retains settings",
      pluginId: "missing-plugin",
      entry: { enabled: false, config: { stale: true } },
      warningPaths: ["plugins.entries.missing-plugin", "plugins.allow"],
    },
  ])(
    "handles $name for missing $pluginId in the allowlist",
    ({ pluginId, entry, warningPaths }) => {
      const plugins = { entries: { [pluginId]: entry }, allow: [pluginId] };
      const res = validatePluginRefs(plugins, []);
      expect(res.ok).toBe(true);
      expect(
        (res.warnings ?? [])
          .filter((warning) => warning.path.startsWith("plugins."))
          .map((warning) => warning.path),
      ).toEqual(warningPaths);
      if (res.ok) {
        expect(res.config.plugins).toMatchObject(plugins);
      }
    },
  );

  describe("missing Codex plugin diagnostics", () => {
    const anthropic = "anthropic/claude-sonnet-4-6";
    const openai = "openai/gpt-5.6";
    const codex = "openai/gpt-5.3-codex-spark";
    const modelSelection = (primary: string, fallbacks: string[] = []) => ({ primary, fallbacks });
    const agentWithSubagent = (primary: string) => ({
      model: modelSelection(primary),
      subagents: { model: primary },
    });
    const withAgents = (
      defaults: Record<string, unknown>,
      entries: Record<string, unknown> = { openclaw: {} },
      rest: Record<string, unknown> = {},
    ) => ({ ...rest, agents: { defaults, entries } });
    const explicitAgents = (
      entries: Record<string, unknown>,
      defaults: Record<string, unknown> = { systemAgent: { agentId: "openclaw" } },
    ) => ({ agents: { ownership: "explicit", defaults, entries } });
    const providerModels = (id: string, baseUrl = "https://api.openai.com/v1") => ({
      providers: { openai: { baseUrl, models: [], agentRuntime: { id } } },
    });
    const runtimePolicy = (model: string, id: string) => ({ [model]: { agentRuntime: { id } } });
    const createPiProviderModels = (baseUrl: string, modelRuntime: "auto" | "codex") => ({
      providers: {
        openai: {
          baseUrl,
          agentRuntime: { id: "pi" },
          models: [{ id: "gpt-5.5", name: "GPT 5.5", agentRuntime: { id: modelRuntime } }],
        },
      },
    });

    const validateMissingCodex = (
      raw: Record<string, unknown>,
      env: NodeJS.ProcessEnv = suiteEnv(),
    ) =>
      validate(
        {
          agents: { entries: { openclaw: {} } },
          plugins: { entries: { codex: {} } },
          ...raw,
        },
        {
          env,
          pluginMetadataSnapshot: { manifestRegistry: { plugins: [], diagnostics: [] } },
        },
      );

    const expectMissingCodexPluginWarning = (warnings: Diagnostics, expected = true) => {
      expect(
        (warnings ?? []).some(
          ({ path: issuePath, message }) =>
            issuePath === "plugins.entries.codex" &&
            message.includes("plugin not installed: codex"),
        ),
      ).toBe(expected);
    };
    const expectCodexRequirement = (
      config: Record<string, unknown>,
      warns = true,
      env: NodeJS.ProcessEnv = suiteEnv(),
    ) => {
      const result = validateMissingCodex(config, env);
      expect(result.ok).toBe(true);
      expectMissingCodexPluginWarning(result.warnings, warns);
    };

    it.each([
      ["string harness primary", "openai/gpt-5.6", false],
      ["native Codex fallback", modelSelection(openai, [codex]), true],
    ] as const)("uses native plugin requirements for ACP %s", (_name, model, needsCodex) => {
      const result = validateMissingCodex(
        explicitAgents(
          { worker: { runtime: { type: "acp", acp: { agent: "cursor" } }, model } },
          { model: modelSelection(anthropic) },
        ),
      );
      expect(result.ok).toBe(true);
      expect(
        (result.warnings ?? []).filter(
          ({ path: issuePath, message }) =>
            issuePath === "plugins.entries.codex" &&
            message.includes("plugin not installed: codex"),
        ),
      ).toHaveLength(needsCodex ? 1 : 0);
    });

    it.each([
      [
        "does not require Codex for a default Decision model beside non-OpenAI chat",
        withAgents({ ...agentWithSubagent(anthropic), decisionModel: "openai/gpt-6-luna" }),
        false,
      ],
      [
        "does not require Codex for a per-agent pinned Decision model",
        withAgents(agentWithSubagent(anthropic), {
          openclaw: { decisionModel: "openai/gpt-6-luna@openai:fixture" },
        }),
        false,
      ],
      [
        "still requires Codex for the same model selected for chat",
        withAgents(agentWithSubagent("openai/gpt-6-luna")),
        true,
      ],
      [
        "keeps channel targets named decisionModel on the chat diagnostic path",
        withAgents(agentWithSubagent(anthropic), undefined, {
          channels: { modelByChannel: { telegram: { decisionModel: "openai/gpt-6-luna" } } },
        }),
        true,
      ],
      [
        "scopes request-parameter diagnostics to the affected keyed agent",
        explicitAgents({
          openclaw: agentWithSubagent(anthropic),
          work: { ...agentWithSubagent(openai), params: { temperature: 0.4 } },
        }),
        false,
      ],
      [
        "still warns when provider PI policy is overridden by an automatic OpenAI model route",
        { models: createPiProviderModels("https://api.openai.com/v1", "auto") },
        true,
      ],
      [
        "does not inherit default fallbacks after a listed agent selects its own primary",
        withAgents(
          { model: modelSelection(openai, [codex]) },
          { worker: { model: { primary: anthropic } } },
        ),
        false,
      ],
      [
        "uses a listed-agent subagent model before the default subagent model",
        withAgents(
          { model: modelSelection(anthropic), subagents: { model: codex } },
          { openclaw: { subagents: { model: anthropic } } },
        ),
        false,
      ],
      [
        "warns when a channel model override needs Codex",
        withAgents({ model: modelSelection(anthropic) }, undefined, {
          channels: { modelByChannel: { telegram: { default: codex } } },
        }),
        true,
      ],
      [
        "does not warn for a fully shadowed default exact Codex policy",
        withAgents(
          { model: modelSelection(openai), models: runtimePolicy(openai, "codex") },
          { openclaw: { models: runtimePolicy(openai, "pi") } },
          { models: providerModels("pi") },
        ),
        false,
      ],
      [
        "does not attribute keyed agent model refs to another agent",
        explicitAgents({
          openclaw: agentWithSubagent(anthropic),
          ops: { ...agentWithSubagent(anthropic), models: runtimePolicy(openai, "pi") },
        }),
        false,
      ],
      [
        "warns when a default exact Codex policy remains reachable by another agent",
        {
          models: providerModels("pi"),
          ...explicitAgents(
            { openclaw: { models: runtimePolicy(openai, "pi") }, worker: {} },
            { model: modelSelection(openai), models: runtimePolicy(openai, "codex") },
          ),
        },
        true,
      ],
      [
        "does not warn when a custom OpenAI-compatible base URL uses automatic runtime policy",
        { models: createPiProviderModels("https://proxy.example.invalid/v1", "auto") },
        false,
      ],
      [
        "does not warn when exact agent policy overrides an automatic OpenAI provider model route",
        withAgents(
          {
            models: {
              ...runtimePolicy("openai/*", "pi"),
              ...runtimePolicy("openai/gpt-5.5", "pi"),
            },
          },
          undefined,
          { models: createPiProviderModels("https://api.openai.com/v1", "auto") },
        ),
        false,
      ],
      [
        "still warns when the missing Codex plugin is explicitly enabled",
        { models: providerModels("pi"), plugins: { entries: { codex: { enabled: true } } } },
        true,
      ],
    ] as const)("%s", (_name, config, warns) => {
      expectCodexRequirement(config, warns);
    });

    it("warns when the utility model needs Codex", () => {
      expectCodexRequirement(withAgents({ model: modelSelection(anthropic), utilityModel: codex }));
    });

    it("keeps the two-argument diagnostic API correct for a legacy list", () => {
      const raw: OpenClawConfigWithLegacyRoster = {
        agents: {
          list: [
            { id: "10", default: true, model: "anthropic/claude-sonnet-4-6" },
            { id: "2", model: "openai/gpt-5.6" },
          ],
        },
      };
      expect(shouldSuppressMissingCodexPluginDiagnostics(raw, suiteEnv())).toBe(false);
    });

    it.each([
      ["codex", "pi", false],
      ["pi", "codex", true],
    ] as const)(
      "uses provider %s / wildcard %s precedence",
      (providerRuntime, wildcardRuntime, warns) => {
        expectCodexRequirement(
          withAgents({ models: runtimePolicy("openai/*", wildcardRuntime) }, undefined, {
            models: providerModels(providerRuntime),
          }),
          warns,
        );
      },
    );

    it("uses the validation environment snapshot for implicit OpenAI routing", () => {
      expectCodexRequirement({}, false, {
        ...suiteEnv(),
        OPENAI_BASE_URL: "https://proxy.example.invalid/v1",
      });
      expectCodexRequirement({}, true, {
        ...suiteEnv(),
        OPENAI_BASE_URL: "https://api.openai.com/v1",
      });
    });
  });

  it("deduplicates catalog install hints for missing configured official external plugins", () => {
    const res = validatePluginRefs({ entries: { brave: { enabled: true } }, allow: ["brave"] }, []);
    expect(res.ok).toBe(true);
    const message =
      "plugin not installed: brave — install the official external plugin with: openclaw plugins install npm:@openclaw/brave-plugin";
    expectMessage(res.warnings, "plugins.entries.brave", message);
    expect((res.warnings ?? []).filter((warning) => warning.message === message)).toHaveLength(1);
    expect(
      (res.warnings ?? []).some(
        (warning) =>
          (warning.path === "plugins.entries.brave" || warning.path === "plugins.allow") &&
          warning.message.includes("remove it from plugins config"),
      ),
    ).toBe(false);
  });

  it("warns instead of failing when an official external memory slot plugin is not installed", () => {
    const res = validatePluginRefs(memorySlot(), []);
    expect(res.ok).toBe(true);
    const slotMessage =
      "plugin not installed: memory-lancedb — gateway will run without persistent memory until installed; install the official external plugin with: openclaw plugins install npm:@openclaw/memory-lancedb";
    const entryMessage =
      "plugin not installed: memory-lancedb — install the official external plugin with: openclaw plugins install npm:@openclaw/memory-lancedb";
    expectMessage(res.warnings, "plugins.slots.memory", slotMessage);
    expectMessage(res.warnings, "plugins.entries.memory-lancedb", entryMessage);
  });

  it("keeps blocked official external memory slot plugins fatal", () => {
    const res = validatePluginRefs(memorySlot(), [
      {
        level: "warn",
        pluginId: "memory-lancedb",
        message: "blocked plugin candidate: fixture safety block",
      },
    ]);
    expectInvalid(res);
    expectIncludes(
      res.issues,
      "plugins.slots.memory",
      "plugin present but blocked: memory-lancedb",
    );
    expectIncludes(
      res.warnings,
      "plugins.entries.memory-lancedb",
      "plugin present but blocked: memory-lancedb",
    );
    expectNoMessage(res.warnings, /plugin not installed: memory-lancedb/);
  });

  it.runIf(process.platform !== "win32")(
    "reports configured blocked plugins without stale not-found wording",
    async () => {
      await fs.chmod(blockedPluginDir, 0o777);
      try {
        const res = validatePluginRefs(loadedPlugin("blocked-plugin", blockedPluginDir));
        expectValid(res);
        for (const warningPath of ["plugins.entries.blocked-plugin", "plugins.allow"]) {
          expectIncludes(res.warnings, warningPath, "plugin present but blocked: blocked-plugin");
        }
        expectNoMessage(
          res.warnings,
          /plugin not found: blocked-plugin|remove it from plugins config/,
        );
      } finally {
        await chmodSafeDir(blockedPluginDir);
      }
    },
  );

  it("maps legacy blocked diagnostics without plugin ids to configured load paths", () => {
    const res = validatePluginRefs(loadedPlugin("blocked-plugin", blockedPluginDir), [
      {
        level: "warn",
        source: path.join(blockedPluginDir, "index.js"),
        message: `blocked plugin candidate: world-writable path (${blockedPluginDir}, mode=0777)`,
      },
    ]);
    expectValid(res);
    for (const warningPath of ["plugins.entries.blocked-plugin", "plugins.allow"]) {
      expectIncludes(res.warnings, warningPath, "plugin present but blocked: blocked-plugin");
    }
    expectNoMessage(res.warnings, /plugin not found: blocked-plugin/);
  });

  it.each([false, true])("makes a broken plugin fatal only when referenced=%s", (referenced) => {
    const res = validatePluginRefs(
      referenced ? { entries: { "broken-local": { enabled: true } } } : { allow: ["telegram"] },
      [
        {
          level: "error",
          pluginId: "broken-local",
          source: path.join(suiteHome, "extensions", "broken-local", "openclaw.plugin.json"),
          message: "plugin manifest entry does not exist: dist/index.js",
        },
      ],
    );
    expect(res.ok).toBe(!referenced);
    expectMessage(
      res.ok ? res.warnings : res.issues,
      referenced ? "plugins.entries.broken-local" : "plugins",
      "plugin broken-local: plugin manifest entry does not exist: dist/index.js",
    );
    if (!referenced) {
      expectNoPath(res.warnings, "plugins.entries.broken-local");
    }
  });

  it("does not source-match blocked diagnostics that already name a different plugin id", () => {
    const aliasDir = path.join(suiteHome, "alias-dir");
    const res = validatePluginRefs(
      {
        enabled: true,
        load: { paths: [aliasDir] },
        entries: { "actual-id": { enabled: true }, "alias-dir": { enabled: true } },
        allow: ["actual-id", "alias-dir"],
      },
      [
        {
          level: "warn",
          pluginId: "actual-id",
          source: path.join(aliasDir, "index.js"),
          message: `blocked plugin candidate: world-writable path (${aliasDir}, mode=0777)`,
        },
      ],
    );
    expectValid(res);
    for (const warningPath of ["plugins.entries.actual-id", "plugins.allow"]) {
      expectIncludes(res.warnings, warningPath, "plugin present but blocked: actual-id");
    }
    const aliasMessage = stalePluginMessage("alias-dir");
    expectMessage(res.warnings, "plugins.entries.alias-dir", aliasMessage);
    expectMessage(res.warnings, "plugins.allow", aliasMessage);
    expectNoMessage(res.warnings, /plugin present but blocked: alias-dir/);
  });

  it("warns instead of failing for stale channel config backed by missing plugin refs", () => {
    const res = validate({
      agents: { entries: { openclaw: {} } },
      channels: { "missing-chat": { token: "stale" } },
      plugins: { allow: ["missing-chat"], entries: { "missing-chat": { enabled: true } } },
    });
    expectValid(res);
    expect(res.warnings).toEqual(
      expect.arrayContaining([
        diagnostic("channels.missing-chat", staleChannelMessage("missing-chat")),
        diagnostic("plugins.allow", stalePluginMessage("missing-chat")),
        diagnostic("plugins.entries.missing-chat", stalePluginMessage("missing-chat")),
      ]),
    );
  });

  it("keeps unknown channel typos fatal when there is no stale plugin evidence", () => {
    const res = validate({
      agents: { entries: { openclaw: {} } },
      channels: { telegarm: { botToken: "typo" } },
      plugins: { allow: ["telegram"] },
    });
    expectInvalid(res);
    expect(res.issues.filter((issue) => issue.path === "channels.telegarm")).toEqual([
      { path: "channels.telegarm", message: "unknown channel id: telegarm" },
    ]);
    expectNoPath(res.warnings, "channels.telegarm");
  });

  it("warns when plugins.allow contains a channel id without a plugin manifest (#76872)", () => {
    const res = validateWithRegistry(
      {
        agents: { entries: { openclaw: {} } },
        channels: { discord: { token: "xxx" } },
        plugins: { allow: ["discord"] },
      },
      [{ level: "info", message: "explicit plugin source selected" }],
    );
    expect(res.ok).toBe(true);
    expect(res.warnings ?? []).toEqual([
      {
        path: "plugins.allow",
        message:
          "plugin not installed: discord — install the official external plugin with: openclaw plugins install npm:@openclaw/discord",
      },
    ]);
  });

  it("uses persisted installed-plugin records as stale channel evidence", async () => {
    const stateDir = path.join(suiteHome, ".openclaw");
    clearLoadInstalledPluginIndexInstallRecordsCache();
    await writeInstalledRecords(stateDir, 1, {
      "missing-sms": {
        source: "npm",
        spec: "missing-sms@1.0.0",
        installedAt: "2026-04-12T00:00:00.000Z",
      },
    });
    clearLoadInstalledPluginIndexInstallRecordsCache();
    try {
      const res = validate({
        agents: { entries: { openclaw: {} } },
        channels: { "missing-sms": { token: "stale" } },
      });
      expectValid(res);
      expect(res.warnings).toContainEqual(
        diagnostic("channels.missing-sms", staleChannelMessage("missing-sms")),
      );
    } finally {
      await writeInstalledRecords(stateDir, 2, {});
      clearLoadInstalledPluginIndexInstallRecordsCache();
    }
  });

  it("warns with actionable guidance when a runtime command name is used in plugins.allow", () => {
    const res = validatePluginRefs({
      allow: ["dreaming"],
      entries: {
        dreaming: { enabled: false },
        "memory-core": { config: { dreaming: { enabled: true } } },
      },
    });
    expect(
      res.warnings?.some(
        (w) => w.path === "plugins.allow" && w.message.includes("plugin not found: dreaming"),
      ),
    ).toBe(false);
    expect(
      res.warnings?.some(
        (w) =>
          w.path === "plugins.allow" &&
          w.message.includes('"dreaming" is not a plugin') &&
          w.message.includes("memory-core"),
      ),
    ).toBe(true);
  });

  it.each([
    [
      "google-antigravity-auth",
      false,
      "plugin removed: google-antigravity-auth (stale config entry ignored; remove it from plugins config)",
    ],
    [
      "skill-workshop",
      true,
      'plugin removed: skill-workshop (stale plugin config ignored; Skill Workshop is built into OpenClaw skills now. Set skills.workshop.autonomous.mode to "auto" or "off" and use openclaw skills workshop commands, then remove this plugins config entry)',
    ],
  ] as const)("warns across all references to removed %s", (id, enabled, message) => {
    const res = validatePluginRefs({
      enabled: false,
      entries: { [id]: { enabled } },
      allow: [id],
      deny: [id],
      slots: { memory: id },
    });
    expect(res.ok).toBe(true);
    for (const warningPath of [
      `plugins.entries.${id}`,
      "plugins.allow",
      "plugins.deny",
      "plugins.slots.memory",
    ]) {
      expectMessage(res.warnings, warningPath, message);
    }
  });

  it("does not auto-allow config-loaded overrides of bundled web search plugin ids", () => {
    const res = validate({
      plugins: {
        allow: ["imessage", "memory-core"],
        load: { paths: [googleOverridePluginDir] },
        entries: { google: { config: { apiKey: "test-google-key" } } },
      },
    });
    expectValid(res);
    expect(res.warnings).toContainEqual({
      path: "plugins.entries.google",
      message: "plugin disabled (not in allowlist) but config is present",
    });
  });

  it("uses manifest defaults when warning about configured bundled plugins (#122746)", () => {
    const res = validate({
      plugins: {
        entries: {
          canvas: { config: { host: { enabled: false } } },
          diffs: { config: { defaults: { fontSize: 15 } } },
        },
      },
    });
    expectValid(res);
    expectNoPath(res.warnings, "plugins.entries.canvas");
    expectMessage(
      res.warnings,
      "plugins.entries.diffs",
      "plugin disabled (bundled (disabled by default)) but config is present",
    );
  });

  it("retains disabled-plugin warnings for authored Codex settings", () => {
    const res = validate({
      plugins: {
        entries: {
          codex: {
            config: { sessionCatalog: { enabled: false, homes: ["/synthetic/catalog"] } },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
    expectIncludes(res.warnings, "plugins.entries.codex", "plugin disabled");
  });

  it("discovers workspace plugins after Doctor preserves legacy ownership", async () => {
    const workspaceDir = path.join(fixtureRoot, "legacy-root-workspace");
    const pluginId = "legacy-root-channel";
    const channelId = "legacy-root";
    await writePluginFixture({
      dir: path.join(workspaceDir, ".openclaw", "extensions", pluginId),
      id: pluginId,
      channels: [channelId],
      schema: { type: "object" },
    });
    const env = suiteEnv();

    const migrated = createCanonicalAgentConfigFixture(
      {
        agents: {
          defaults: { workspace: workspaceDir },
          entries: { ops: { default: true }, research: {} },
        },
        channels: { [channelId]: {} },
        plugins: { entries: { [pluginId]: { enabled: true } } },
      },
      { env, homedir: () => suiteHome },
    ).config;
    const res = validate(migrated, {
      env,
      loadPluginMetadataSnapshot: (config) => ({
        manifestRegistry: resolveConfigWidePluginManifestRegistry({
          config,
          env,
          allowCurrent: false,
        }),
      }),
    });
    expectValid(res);
    expect(res.config.bindings).toContainEqual({
      agentId: "ops",
      match: { channel: channelId, accountId: "*" },
    });
  });

  it("accepts dynamic Codex marketplaces and surfaces unsafe identifiers as diagnostics", () => {
    const github = codexMarketplace({ enabled: true, marketplaceName: "openai-monorepo" });
    const config = { codexPlugins: { enabled: true, plugins: { github } } };
    expect(validateCodexConfig(config).ok).toBe(true);

    github.marketplaceName = "../unsafe-marketplace";
    const res = validateCodexConfig(config);
    expectIssue(
      res,
      "plugins.entries.codex.config.codexPlugins.plugins.github.marketplaceName",
      "invalid config",
    );
  });

  it("accepts enabled manifestless Claude bundles without a native schema", () => {
    const res = validatePluginRefs({
      enabled: true,
      load: { paths: [manifestlessClaudeBundleDir] },
      entries: { "manifestless-claude-bundle": { enabled: true } },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts ask destructive policy without dropping adjacent Codex plugin config", () => {
    const res = validateCodexConfig({
      codexDynamicToolsLoading: "direct",
      codexPlugins: destructivePolicy("ask", { enabled: false, allow_destructive_actions: "auto" }),
    });
    expect(res.ok).toBe(true);
  });

  it.each([
    ["global policy", "", destructivePolicy("always")],
    [
      "per-plugin policy",
      "plugins.github.",
      destructivePolicy("ask", { allow_destructive_actions: "always" }),
    ],
  ] as const)("rejects old always destructive policy in the %s", (_name, prefix, codexPlugins) => {
    const res = validateCodexConfig({ codexPlugins });
    expectIssue(
      res,
      `plugins.entries.codex.config.codexPlugins.${prefix}allow_destructive_actions`,
      "invalid config",
    );
  });
});
