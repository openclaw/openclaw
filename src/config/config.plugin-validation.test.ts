import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { clearLoadInstalledPluginIndexInstallRecordsCache } from "../plugins/installed-plugin-index-records.js";
import { writePersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store-write.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { shouldSuppressMissingCodexPluginDiagnostics } from "./codex-plugin-diagnostics.js";
import { resolveConfigWidePluginManifestRegistry } from "./io.plugin-metadata.js";
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
  schema: Record<string, unknown>;
  channels?: string[];
}) {
  await mkdirSafe(params.dir);
  await fs.writeFile(
    path.join(params.dir, "index.js"),
    `export default { id: "${params.id}", register() {} };`,
    "utf-8",
  );
  const manifest: Record<string, unknown> = {
    id: params.id,
    configSchema: params.schema,
  };
  if (params.channels) {
    manifest.channels = params.channels;
  }
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

function expectPathMessage(entries: Diagnostics, pathValue: string, message: string) {
  expect(entries?.some((entry) => entry.path === pathValue && entry.message === message)).toBe(
    true,
  );
}

function expectPathMessageIncludes(entries: Diagnostics, pathValue: string, fragment: string) {
  expect(
    entries?.some((entry) => entry.path === pathValue && entry.message.includes(fragment)),
  ).toBe(true);
}

function expectNoPath(entries: Diagnostics, pathValue: string) {
  expect(entries?.some((entry) => entry.path === pathValue)).toBe(false);
}

describe("config plugin validation", () => {
  let fixtureRoot = "";
  let suiteHome = "";
  let enumPluginDir = "";
  let chatPluginDir = "";
  let googleOverridePluginDir = "";
  let comfySchemaPluginDir = "";
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

  const validateConfigObjectWithPlugins = (
    raw: unknown,
    options: Parameters<typeof validateConfigObjectWithPluginsRaw>[1] = {},
  ) =>
    validateConfigObjectWithPluginsRaw(raw, {
      ...options,
      env: options.env ?? suiteEnv(),
    });

  const validateInSuite = (raw: unknown) => validateConfigObjectWithPlugins(raw);

  const validateWithRegistry = (
    raw: unknown,
    diagnostics: PluginManifestRegistry["diagnostics"] = [],
  ) =>
    validateConfigObjectWithPlugins(raw, {
      pluginMetadataSnapshot: { manifestRegistry: { plugins: [], diagnostics } },
    });

  const validatePluginRefs = (
    plugins: unknown,
    diagnostics?: PluginManifestRegistry["diagnostics"],
  ) => {
    const raw = { agents: { entries: { openclaw: {} } }, plugins };
    return diagnostics ? validateWithRegistry(raw, diagnostics) : validateInSuite(raw);
  };

  const validateRemovedPluginConfig = (removedId: string, enabled = true) =>
    validatePluginRefs({
      enabled: false,
      entries: { [removedId]: { enabled } },
      allow: [removedId],
      deny: [removedId],
      slots: { memory: removedId },
    });

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-plugin-validation-"));
    await chmodSafeDir(fixtureRoot);
    suiteHome = path.join(fixtureRoot, "home");
    await mkdirSafe(suiteHome);
    enumPluginDir = path.join(suiteHome, "enum-plugin");
    chatPluginDir = path.join(suiteHome, "chat-plugin");
    await writePluginFixture({
      dir: enumPluginDir,
      id: "enum-plugin",
      schema: {
        type: "object",
        properties: {
          fileFormat: {
            type: "string",
            enum: ["markdown", "html"],
          },
        },
        required: ["fileFormat"],
      },
    });
    await writePluginFixture({
      dir: chatPluginDir,
      id: "chat-plugin",
      channels: ["chat"],
      schema: { type: "object" },
    });
    googleOverridePluginDir = path.join(suiteHome, "google");
    await writePluginFixture({
      dir: googleOverridePluginDir,
      id: "google",
      schema: {
        type: "object",
        properties: {
          apiKey: { type: "string" },
        },
      },
    });
    comfySchemaPluginDir = path.join(suiteHome, "comfy-schema-plugin");
    const comfyManifestPath = path.join(
      process.cwd(),
      "extensions",
      "comfy",
      "openclaw.plugin.json",
    );
    const comfyManifest = JSON.parse(await fs.readFile(comfyManifestPath, "utf-8")) as {
      configSchema?: Record<string, unknown>;
    };
    if (!comfyManifest.configSchema) {
      throw new Error("comfy manifest missing configSchema");
    }
    await writePluginFixture({
      dir: comfySchemaPluginDir,
      id: "comfy",
      schema: comfyManifest.configSchema,
    });
    manifestlessClaudeBundleDir = path.join(suiteHome, "manifestless-claude-bundle");
    await writeManifestlessClaudeBundleFixture({
      dir: manifestlessClaudeBundleDir,
    });
    blockedPluginDir = path.join(suiteHome, "blocked-plugin");
    await writePluginFixture({
      dir: blockedPluginDir,
      id: "blocked-plugin",
      schema: { type: "object" },
    });
    malformedSchemaPluginDir = path.join(suiteHome, "malformed-schema-plugin");
    await writePluginFixture({
      dir: malformedSchemaPluginDir,
      id: "malformed-schema-plugin",
      schema: {
        type: "object",
        properties: { mode: { $ref: "#/$defs/Mode" } },
      },
    });
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("reports a malformed plugin configSchema as an issue instead of throwing", () => {
    const res = validatePluginRefs({
      enabled: true,
      load: { paths: [malformedSchemaPluginDir] },
      entries: { "malformed-schema-plugin": { enabled: true } },
      allow: ["malformed-schema-plugin"],
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expectPathMessageIncludes(
        res.issues,
        "plugins.entries.malformed-schema-plugin.config",
        "invalid schema",
      );
    }
  });

  it("keeps malformed bundled plugin schemas on the throwing path", () => {
    const bundledRecord = {
      id: "bundled-schema-plugin",
      channels: [],
      cliBackends: [],
      configSchema: {
        type: "object",
        properties: { mode: { $ref: "#/$defs/Mode" } },
      },
      hooks: [],
      manifestPath: "/bundled/schema/openclaw.plugin.json",
      origin: "bundled",
      providers: [],
      rootDir: "/bundled/schema",
      skills: [],
      source: "/bundled/schema/index.js",
    } satisfies PluginManifestRecord;

    expect(() =>
      validateConfigObjectWithPlugins(
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
      entries: {
        "missing-plugin": { enabled: true },
        "missing-slot": { enabled: false },
      },
      allow: ["missing-allow", "missing-slot"],
      deny: ["missing-deny"],
      slots: { memory: "missing-slot" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expectPathMessage(res.issues, "plugins.slots.memory", "plugin not found: missing-slot");
      expect(res.warnings.filter((warning) => warning.path.startsWith("plugins."))).toEqual([
        {
          path: "plugins.entries.missing-plugin",
          message:
            "plugin not found: missing-plugin (stale config entry ignored; remove it from plugins config)",
        },
        {
          path: "plugins.allow",
          message:
            "plugin not found: missing-allow (stale config entry ignored; remove it from plugins config)",
        },
        {
          path: "plugins.deny",
          message:
            "plugin not found: missing-deny (stale config entry ignored; remove it from plugins config)",
        },
      ]);
    }
  });

  it("accepts Comfy workflow settings under the canonical plugin config root", () => {
    const res = validateInSuite({
      agents: { entries: { openclaw: {} } },
      plugins: {
        enabled: true,
        load: { paths: [comfySchemaPluginDir] },
        entries: {
          comfy: {
            config: {
              workflowFileMaxBytes: 100 * 1024 * 1024,
              image: {
                workflowPath: "./workflow.json",
                promptNodeId: "6",
              },
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
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
    const providerModels = (id: string, baseUrl = "https://api.openai.com/v1") => ({
      providers: { openai: { baseUrl, models: [], agentRuntime: { id } } },
    });
    const runtimePolicy = (model: string, id: string) => ({ [model]: { agentRuntime: { id } } });
    const createPiProviderModels = (baseUrl: string, modelRuntime: "auto" | "codex") => ({
      providers: {
        openai: {
          baseUrl,
          agentRuntime: { id: "pi" },
          models: [
            {
              id: "gpt-5.5",
              name: "GPT 5.5",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 8192,
              agentRuntime: { id: modelRuntime },
            },
          ],
        },
      },
    });

    const validateWithMissingCodexPlugin = (
      raw: Record<string, unknown>,
      env: NodeJS.ProcessEnv = suiteEnv(),
    ) =>
      validateConfigObjectWithPlugins(
        {
          agents: { entries: { openclaw: {} } },
          plugins: { entries: { codex: {} } },
          ...raw,
        },
        {
          env,
          pluginMetadataSnapshot: {
            manifestRegistry: {
              plugins: [],
              diagnostics: [],
            },
          },
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

    it.each([
      {
        name: "provider-level PI runtime policy",
        config: {
          models: providerModels("pi"),
        },
      },
      {
        name: "explicitly disabled Codex plugin entry",
        config: {
          plugins: { entries: { codex: { enabled: false } } },
        },
      },
    ])("does not warn when $name keeps Codex unavailable", ({ config }) => {
      const res = validateWithMissingCodexPlugin(config);

      expect(res.ok).toBe(true);
      expectMissingCodexPluginWarning(res.warnings, false);
    });

    it.each([
      {
        name: "scopes request-parameter diagnostics to the affected keyed agent",
        config: {
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "openclaw" } },
            entries: {
              openclaw: {
                model: { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] },
                subagents: { model: "anthropic/claude-sonnet-4-6" },
              },
              work: {
                model: { primary: "openai/gpt-5.6", fallbacks: [] },
                subagents: { model: "openai/gpt-5.6" },
                params: { temperature: 0.4 },
              },
            },
          },
        },
        warns: false,
      },
      {
        name: "still warns when provider PI policy is overridden by an automatic OpenAI model route",
        config: {
          models: createPiProviderModels("https://api.openai.com/v1", "auto"),
        },
        warns: true,
      },
      {
        name: "does not inherit default fallbacks after a listed agent selects its own primary",
        config: {
          agents: {
            defaults: {
              model: {
                primary: "openai/gpt-5.6",
                fallbacks: ["openai/gpt-5.3-codex-spark"],
              },
            },
            entries: { worker: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
          },
        },
        warns: false,
      },
      {
        name: "uses a listed-agent subagent model before the default subagent model",
        config: {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] },
              subagents: { model: "openai/gpt-5.3-codex-spark" },
            },
            entries: { openclaw: { subagents: { model: "anthropic/claude-sonnet-4-6" } } },
          },
        },
        warns: false,
      },
      {
        name: "warns when an effective heartbeat route needs Codex",
        config: {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] },
              heartbeat: { model: "openai/gpt-5.3-codex-spark" },
            },
            entries: { openclaw: {} },
          },
        },
        warns: true,
      },
      {
        name: "warns when a channel model override needs Codex",
        config: {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] },
            },
            entries: { openclaw: {} },
          },
          channels: {
            modelByChannel: {
              telegram: { default: "openai/gpt-5.3-codex-spark" },
            },
          },
        },
        warns: true,
      },
      {
        name: "does not warn for a fully shadowed default exact Codex policy",
        config: {
          models: providerModels("pi"),
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.6", fallbacks: [] },
              models: runtimePolicy("openai/gpt-5.6", "codex"),
            },
            entries: { openclaw: { models: runtimePolicy("openai/gpt-5.6", "pi") } },
          },
        },
        warns: false,
      },
      {
        name: "does not attribute keyed agent model refs to another agent",
        config: {
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "openclaw" } },
            entries: {
              openclaw: {
                model: { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] },
                subagents: { model: "anthropic/claude-sonnet-4-6" },
              },
              ops: {
                model: { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] },
                subagents: { model: "anthropic/claude-sonnet-4-6" },
                models: runtimePolicy("openai/gpt-5.6", "pi"),
              },
            },
          },
        },
        warns: false,
      },
      {
        name: "warns when a default exact Codex policy remains reachable by another agent",
        config: {
          models: providerModels("pi"),
          agents: {
            ownership: "explicit",
            defaults: {
              model: { primary: "openai/gpt-5.6", fallbacks: [] },
              models: runtimePolicy("openai/gpt-5.6", "codex"),
            },
            entries: { openclaw: { models: runtimePolicy("openai/gpt-5.6", "pi") }, worker: {} },
          },
        },
        warns: true,
      },
      {
        name: "does not warn when a custom OpenAI-compatible base URL uses automatic runtime policy",
        config: {
          models: createPiProviderModels("https://proxy.example.invalid/v1", "auto"),
        },
        warns: false,
      },
      {
        name: "does not warn when exact agent policy overrides an automatic OpenAI provider model route",
        config: {
          models: createPiProviderModels("https://api.openai.com/v1", "auto"),
          agents: {
            entries: { openclaw: {} },
            defaults: {
              models: {
                "openai/*": { agentRuntime: { id: "pi" } },
                "openai/gpt-5.5": { agentRuntime: { id: "pi" } },
              },
            },
          },
        },
        warns: false,
      },
      {
        name: "still warns when the missing Codex plugin is explicitly enabled",
        config: {
          models: providerModels("pi"),
          plugins: { entries: { codex: { enabled: true } } },
        },
        warns: true,
      },
    ])("$name", ({ config, warns }) => {
      const res = validateWithMissingCodexPlugin(config);
      expect(res.ok).toBe(true);
      expectMissingCodexPluginWarning(res.warnings, warns);
    });

    it("warns when automatic model policy overrides provider PI", () => {
      const res = validateWithMissingCodexPlugin({
        models: providerModels("pi"),
        agents: {
          entries: { openclaw: {} },
          defaults: {
            models: {
              "openai/gpt-5.6": { agentRuntime: { id: "default" } },
            },
          },
        },
      });

      expect(res.ok).toBe(true);
      expectMissingCodexPluginWarning(res.warnings);
    });

    it("warns when the utility model needs Codex", () => {
      const res = validateWithMissingCodexPlugin({
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] },
            utilityModel: "openai/gpt-5.3-codex-spark",
          },
          entries: { openclaw: {} },
        },
      });

      expect(res.ok).toBe(true);
      expectMissingCodexPluginWarning(res.warnings);
    });

    it("keeps the two-argument diagnostic API correct for a legacy list", () => {
      expect(
        shouldSuppressMissingCodexPluginDiagnostics(
          {
            agents: {
              list: [
                {
                  id: "10",
                  default: true,
                  model: "anthropic/claude-sonnet-4-6",
                },
                { id: "2", model: "openai/gpt-5.6" },
              ],
            },
          },
          suiteEnv(),
        ),
      ).toBe(false);
    });

    it.each([
      {
        name: "agent wildcard PI over provider Codex",
        providerRuntime: "codex",
        wildcardRuntime: "pi",
        warns: false,
      },
      {
        name: "agent wildcard Codex over provider PI",
        providerRuntime: "pi",
        wildcardRuntime: "codex",
        warns: true,
      },
    ])("uses $name precedence", ({ providerRuntime, wildcardRuntime, warns }) => {
      const res = validateWithMissingCodexPlugin({
        models: providerModels(providerRuntime),
        agents: {
          entries: { openclaw: {} },
          defaults: {
            models: runtimePolicy("openai/*", wildcardRuntime),
          },
        },
      });

      expect(res.ok).toBe(true);
      expectMissingCodexPluginWarning(res.warnings, warns);
    });

    it("uses the validation environment snapshot for implicit OpenAI routing", () => {
      const config = {};
      const customEnv = {
        ...suiteEnv(),
        OPENAI_BASE_URL: "https://proxy.example.invalid/v1",
      };
      const platformEnv = {
        ...suiteEnv(),
        OPENAI_BASE_URL: "https://api.openai.com/v1",
      };

      const customResult = validateWithMissingCodexPlugin(config, customEnv);
      const platformResult = validateWithMissingCodexPlugin(config, platformEnv);

      expect(customResult.ok).toBe(true);
      expectMissingCodexPluginWarning(customResult.warnings, false);
      expect(platformResult.ok).toBe(true);
      expectMissingCodexPluginWarning(platformResult.warnings);
    });

    it("still reports explicit Codex allowlist entries for custom OpenAI-compatible base URLs", () => {
      const res = validateWithMissingCodexPlugin({
        models: {
          providers: {
            openai: {
              baseUrl: "https://proxy.example.invalid/v1",
              models: [],
            },
          },
        },
        plugins: {
          allow: ["codex"],
          entries: { codex: {} },
        },
      });

      expect(res.ok).toBe(true);
      expectMissingCodexPluginWarning(res.warnings, false);
      expect(res.warnings ?? []).toContainEqual(
        expect.objectContaining({
          path: "plugins.allow",
          message:
            "plugin not installed: codex — install the official external plugin with: openclaw plugins install @openclaw/codex",
        }),
      );
    });
  });

  it("deduplicates catalog install hints for missing configured official external plugins", () => {
    const res = validatePluginRefs(
      {
        entries: { brave: { enabled: true } },
        allow: ["brave"],
      },
      [],
    );

    expect(res.ok).toBe(true);
    const message =
      "plugin not installed: brave — install the official external plugin with: openclaw plugins install @openclaw/brave-plugin";
    expectPathMessage(res.warnings, "plugins.entries.brave", message);
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
    const res = validatePluginRefs(
      {
        slots: { memory: "memory-lancedb" },
        entries: { "memory-lancedb": { enabled: true } },
      },
      [],
    );

    expect(res.ok).toBe(true);
    const slotMessage =
      "plugin not installed: memory-lancedb — gateway will run without persistent memory until installed; install the official external plugin with: openclaw plugins install @openclaw/memory-lancedb";
    const entryMessage =
      "plugin not installed: memory-lancedb — install the official external plugin with: openclaw plugins install @openclaw/memory-lancedb";
    expectPathMessage(res.warnings, "plugins.slots.memory", slotMessage);
    expectPathMessage(res.warnings, "plugins.entries.memory-lancedb", entryMessage);
  });

  it("keeps blocked official external memory slot plugins fatal", () => {
    const res = validatePluginRefs(
      {
        slots: { memory: "memory-lancedb" },
        entries: { "memory-lancedb": { enabled: true } },
      },
      [
        {
          level: "warn",
          pluginId: "memory-lancedb",
          message: "blocked plugin candidate: fixture safety block",
        },
      ],
    );

    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    expectPathMessageIncludes(
      res.issues,
      "plugins.slots.memory",
      "plugin present but blocked: memory-lancedb",
    );
    expectPathMessageIncludes(
      res.warnings,
      "plugins.entries.memory-lancedb",
      "plugin present but blocked: memory-lancedb",
    );
    expect(
      res.warnings?.some((warning) =>
        warning.message.includes("plugin not installed: memory-lancedb"),
      ),
    ).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "reports configured blocked plugins without stale not-found wording",
    async () => {
      await fs.chmod(blockedPluginDir, 0o777);
      try {
        const res = validatePluginRefs({
          enabled: true,
          load: { paths: [blockedPluginDir] },
          entries: { "blocked-plugin": { enabled: true } },
          allow: ["blocked-plugin"],
        });

        expect(res.ok).toBe(true);
        if (!res.ok) {
          return;
        }
        for (const warningPath of ["plugins.entries.blocked-plugin", "plugins.allow"]) {
          expectPathMessageIncludes(
            res.warnings,
            warningPath,
            "plugin present but blocked: blocked-plugin",
          );
        }
        expect(
          res.warnings.some(
            (warning) =>
              warning.message.includes("plugin not found: blocked-plugin") ||
              warning.message.includes("remove it from plugins config"),
          ),
        ).toBe(false);
      } finally {
        await chmodSafeDir(blockedPluginDir);
      }
    },
  );

  it("maps legacy blocked diagnostics without plugin ids to configured load paths", () => {
    const res = validatePluginRefs(
      {
        enabled: true,
        load: { paths: [blockedPluginDir] },
        entries: { "blocked-plugin": { enabled: true } },
        allow: ["blocked-plugin"],
      },
      [
        {
          level: "warn",
          source: path.join(blockedPluginDir, "index.js"),
          message: `blocked plugin candidate: world-writable path (${blockedPluginDir}, mode=0777)`,
        },
      ],
    );

    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    for (const warningPath of ["plugins.entries.blocked-plugin", "plugins.allow"]) {
      expectPathMessageIncludes(
        res.warnings,
        warningPath,
        "plugin present but blocked: blocked-plugin",
      );
    }
    expect(
      res.warnings.some((warning) => warning.message.includes("plugin not found: blocked-plugin")),
    ).toBe(false);
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
    expectPathMessage(
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
        entries: {
          "actual-id": { enabled: true },
          "alias-dir": { enabled: true },
        },
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

    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    for (const warningPath of ["plugins.entries.actual-id", "plugins.allow"]) {
      expectPathMessageIncludes(res.warnings, warningPath, "plugin present but blocked: actual-id");
    }
    const aliasMessage =
      "plugin not found: alias-dir (stale config entry ignored; remove it from plugins config)";
    expectPathMessage(res.warnings, "plugins.entries.alias-dir", aliasMessage);
    expectPathMessage(res.warnings, "plugins.allow", aliasMessage);
    expect(
      res.warnings.some((warning) =>
        warning.message.includes("plugin present but blocked: alias-dir"),
      ),
    ).toBe(false);
  });

  it("warns instead of failing for stale channel config backed by missing plugin refs", () => {
    const res = validateInSuite({
      agents: { entries: { openclaw: {} } },
      channels: {
        "missing-chat": { token: "stale" },
      },
      plugins: {
        allow: ["missing-chat"],
        entries: { "missing-chat": { enabled: true } },
      },
    });

    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.warnings).toContainEqual({
      path: "channels.missing-chat",
      message:
        "unknown channel id: missing-chat (stale channel plugin config ignored; run openclaw doctor --fix to remove stale config, or install the plugin)",
    });
    expect(res.warnings).toContainEqual({
      path: "plugins.allow",
      message:
        "plugin not found: missing-chat (stale config entry ignored; remove it from plugins config)",
    });
    expect(res.warnings).toContainEqual({
      path: "plugins.entries.missing-chat",
      message:
        "plugin not found: missing-chat (stale config entry ignored; remove it from plugins config)",
    });
  });

  it("keeps unknown channel typos fatal when there is no stale plugin evidence", () => {
    const res = validateInSuite({
      agents: { entries: { openclaw: {} } },
      channels: {
        telegarm: { botToken: "typo" },
      },
      plugins: {
        allow: ["telegram"],
      },
    });

    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    expect(res.issues.filter((issue) => issue.path === "channels.telegarm")).toEqual([
      {
        path: "channels.telegarm",
        message: "unknown channel id: telegarm",
      },
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
          "plugin not installed: discord — install the official external plugin with: openclaw plugins install @openclaw/discord",
      },
    ]);
  });

  it("uses persisted installed-plugin records as stale channel evidence", async () => {
    const stateDir = path.join(suiteHome, ".openclaw");
    clearLoadInstalledPluginIndexInstallRecordsCache();
    await writePersistedInstalledPluginIndex(
      {
        version: 1,
        hostContractVersion: "test",
        compatRegistryVersion: "test",
        migrationVersion: 1,
        policyHash: "test",
        generatedAtMs: 1,
        installRecords: {
          "missing-sms": {
            source: "npm",
            spec: "missing-sms@1.0.0",
            installedAt: "2026-04-12T00:00:00.000Z",
          },
        },
        plugins: [],
        diagnostics: [],
      },
      { stateDir },
    );
    clearLoadInstalledPluginIndexInstallRecordsCache();
    try {
      const res = validateInSuite({
        agents: { entries: { openclaw: {} } },
        channels: {
          "missing-sms": { token: "stale" },
        },
      });

      expect(res.ok).toBe(true);
      if (!res.ok) {
        return;
      }
      expect(res.warnings).toContainEqual({
        path: "channels.missing-sms",
        message:
          "unknown channel id: missing-sms (stale channel plugin config ignored; run openclaw doctor --fix to remove stale config, or install the plugin)",
      });
    } finally {
      await writePersistedInstalledPluginIndex(
        {
          version: 1,
          hostContractVersion: "test",
          compatRegistryVersion: "test",
          migrationVersion: 1,
          policyHash: "test",
          generatedAtMs: 2,
          installRecords: {},
          plugins: [],
          diagnostics: [],
        },
        { stateDir },
      );
      clearLoadInstalledPluginIndexInstallRecordsCache();
    }
  });

  it("warns with actionable guidance when a runtime command name is used in plugins.allow", () => {
    const res = validatePluginRefs({
      allow: ["dreaming"],
      entries: {
        dreaming: { enabled: false },
        "memory-core": {
          config: { dreaming: { enabled: true } },
        },
      },
    });
    // Should not produce the generic "plugin not found" warning.
    expect(
      res.warnings?.some(
        (w) => w.path === "plugins.allow" && w.message.includes("plugin not found: dreaming"),
      ),
    ).toBe(false);
    // Should produce a helpful redirect to the parent plugin.
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
      "plugin removed: skill-workshop (stale plugin config ignored; Skill Workshop is built into OpenClaw skills now. Use skills.workshop settings and openclaw skills workshop commands, then remove this plugins config entry)",
    ],
  ] as const)("warns across all references to removed %s", (id, enabled, message) => {
    const res = validateRemovedPluginConfig(id, enabled);
    expect(res.ok).toBe(true);
    for (const warningPath of [
      `plugins.entries.${id}`,
      "plugins.allow",
      "plugins.deny",
      "plugins.slots.memory",
    ]) {
      expectPathMessage(res.warnings, warningPath, message);
    }
  });

  it("does not auto-allow config-loaded overrides of bundled web search plugin ids", () => {
    const res = validateInSuite({
      plugins: {
        allow: ["imessage", "memory-core"],
        load: {
          paths: [googleOverridePluginDir],
        },
        entries: {
          google: {
            config: {
              apiKey: "test-google-key",
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.warnings).toContainEqual({
      path: "plugins.entries.google",
      message: "plugin disabled (not in allowlist) but config is present",
    });
  });

  it("uses manifest defaults when warning about configured bundled plugins (#122746)", () => {
    const res = validateInSuite({
      plugins: {
        entries: {
          canvas: { config: { host: { enabled: false } } },
          diffs: { config: { defaults: { fontSize: 15 } } },
        },
      },
    });

    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expectNoPath(res.warnings, "plugins.entries.canvas");
    expectPathMessage(
      res.warnings,
      "plugins.entries.diffs",
      "plugin disabled (bundled (disabled by default)) but config is present",
    );
  });

  it.each([{ config: { sessionCatalog: { enabled: false, homes: ["/synthetic/catalog"] } } }])(
    "retains disabled-plugin warnings for authored Codex settings: %j",
    (entry) => {
      const res = validateInSuite({ plugins: { entries: { codex: entry } } });

      expect(res.ok).toBe(true);
      expectPathMessageIncludes(res.warnings, "plugins.entries.codex", "plugin disabled");
    },
  );

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
    const res = validateConfigObjectWithPlugins(migrated, {
      env,
      loadPluginMetadataSnapshot: (config) => ({
        manifestRegistry: resolveConfigWidePluginManifestRegistry({
          config,
          env,
          allowCurrent: false,
        }),
      }),
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.bindings).toContainEqual({
        agentId: "ops",
        match: { channel: channelId, accountId: "*" },
      });
    }
  });

  it("accepts dynamic Codex marketplaces and surfaces unsafe identifiers as diagnostics", () => {
    const github = { enabled: true, marketplaceName: "openai-monorepo", pluginName: "github" };
    const config = {
      agents: { entries: { openclaw: {} } },
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: { codexPlugins: { enabled: true, plugins: { github } } },
          },
        },
      },
    };
    const options = {
      env: {
        ...suiteEnv(),
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(process.cwd(), "extensions"),
      },
    };

    expect(validateConfigObjectWithPlugins(config, options).ok).toBe(true);

    github.marketplaceName = "../unsafe-marketplace";
    const res = validateConfigObjectWithPlugins(config, options);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expectPathMessageIncludes(
        res.issues,
        "plugins.entries.codex.config.codexPlugins.plugins.github.marketplaceName",
        "invalid config",
      );
    }
  });

  it("accepts enabled manifestless Claude bundles without a native schema", () => {
    const res = validatePluginRefs({
      enabled: true,
      load: { paths: [manifestlessClaudeBundleDir] },
      entries: { "manifestless-claude-bundle": { enabled: true } },
    });

    expect(res.ok).toBe(true);
  });

  it("surfaces allowed enum values for plugin config diagnostics", () => {
    const res = validatePluginRefs({
      enabled: true,
      load: { paths: [enumPluginDir] },
      entries: { "enum-plugin": { config: { fileFormat: "txt" } } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const issue = res.issues.find(
        (entry) => entry.path === "plugins.entries.enum-plugin.config.fileFormat",
      );
      expect(issue?.message).toContain('allowed: "markdown", "html"');
      expect(issue?.allowedValues).toEqual(["markdown", "html"]);
      expect(issue?.allowedValuesHiddenCount).toBe(0);
    }
  });

  it("accepts plugin heartbeat targets", () => {
    const res = validateInSuite({
      agents: { defaults: { heartbeat: { target: "chat" } }, entries: { openclaw: {} } },
      plugins: { enabled: false, load: { paths: [chatPluginDir] } },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts bundled channel aliases for heartbeat targets", () => {
    const res = validateInSuite({
      agents: { defaults: { heartbeat: { target: "gchat" } }, entries: { pi: {} } },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects unknown heartbeat targets", () => {
    const res = validateInSuite({
      agents: {
        defaults: { heartbeat: { target: "not-a-channel" } },
        entries: { openclaw: {} },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.issues.filter((issue) => issue.path === "agents.defaults.heartbeat.target"),
      ).toEqual([
        {
          path: "agents.defaults.heartbeat.target",
          message: "unknown heartbeat target: not-a-channel",
        },
      ]);
    }
  });
  it("accepts ask destructive policy without dropping adjacent Codex plugin config", () => {
    const res = validateConfigObjectWithPlugins(
      {
        agents: { entries: { openclaw: {} } },
        plugins: {
          entries: {
            codex: {
              enabled: true,
              config: {
                codexDynamicToolsLoading: "direct",
                codexPlugins: {
                  enabled: true,
                  allow_destructive_actions: "ask",
                  plugins: {
                    github: {
                      enabled: false,
                      marketplaceName: "openai-curated",
                      pluginName: "github",
                      allow_destructive_actions: "auto",
                    },
                  },
                },
              },
            },
          },
        },
      },
      {
        env: {
          ...suiteEnv(),
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(process.cwd(), "extensions"),
        },
      },
    );

    expect(res.ok).toBe(true);
  });

  it.each([
    {
      name: "global policy",
      expectedPath: "plugins.entries.codex.config.codexPlugins.allow_destructive_actions",
      codexPlugins: {
        enabled: true,
        allow_destructive_actions: "always",
        plugins: {},
      },
    },
    {
      name: "per-plugin policy",
      expectedPath:
        "plugins.entries.codex.config.codexPlugins.plugins.github.allow_destructive_actions",
      codexPlugins: {
        enabled: true,
        allow_destructive_actions: "ask",
        plugins: {
          github: {
            marketplaceName: "openai-curated",
            pluginName: "github",
            allow_destructive_actions: "always",
          },
        },
      },
    },
  ])("rejects old always destructive policy in the $name", ({ codexPlugins, expectedPath }) => {
    const res = validateConfigObjectWithPlugins(
      {
        agents: { entries: { openclaw: {} } },
        plugins: {
          entries: {
            codex: {
              enabled: true,
              config: { codexPlugins },
            },
          },
        },
      },
      {
        env: {
          ...suiteEnv(),
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(process.cwd(), "extensions"),
        },
      },
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expectPathMessageIncludes(res.issues, expectedPath, "invalid config");
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
