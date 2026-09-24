import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveAgentConfig } from "../agents/agent-scope-config.js";
import {
  evaluateContextWindowGuard,
  resolveContextWindowInfo,
} from "../agents/context-window-guard.js";
import { buildConfiguredFallbackModel } from "../agents/embedded-agent-runner/model.configured-fallback.js";
import { resolveHumanDelayConfig, resolveResponsePrefix } from "../agents/identity.js";
import { resolveAgentTimeoutMs } from "../agents/timeout.js";
import { resolveTextChunkLimit } from "../auto-reply/chunk.js";
import { resolveChannelDraftStreamingChunking } from "../channels/draft-streaming-chunking.js";
import { resolveChannelStreamingPreviewCommandText } from "../channels/streaming.js";
import { resolveControlUiBootstrapPresentation } from "../gateway/control-ui-bootstrap-presentation.js";
import { resolveConcurrency, resolveEntryRunOptions } from "../media-understanding/resolve.js";
import { resolveSpeechProviderTimeoutMs } from "../tts/tts-provider-resolution.js";
import { resolveTtsConfig } from "../tts/tts-settings.js";
import { createConfigIO } from "./io.factory.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function configReader(config: unknown) {
  const home = tempDirs.make("openclaw-runtime-optional-");
  const configPath = path.join(home, "openclaw.json");
  const raw = JSON.stringify(config);
  await fs.writeFile(configPath, raw);
  const logger = { warn: vi.fn(), error: vi.fn() };
  const io = createConfigIO({
    configPath,
    env: { HOME: home, OPENCLAW_STATE_DIR: home, UNIT5_TOKEN: "test-fixture-token" },
    homedir: () => home,
    observe: false,
    logger,
  });
  return { home, configPath, raw, logger, io };
}

describe("runtime optional values", () => {
  it.each([
    null,
    "bad",
    {},
    { label: "Preview" },
    { label: 7, color: "red" },
    { label: "Preview", color: "bad" },
  ])(
    "omits only an unusable appearance annotation (%j) and invalid appearance leaves",
    async (environment) => {
      const source = {
        ui: { seamColor: 42, prefs: { theme: "bad", themeMode: 42, accent: "bad" } },
        gateway: { controlUi: { communityInvite: "false", environment } },
      };
      const { io, configPath, raw } = await configReader(source);
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
      expect(snapshot.runtimeConfig.ui?.prefs).toEqual({});
      expect(resolveControlUiBootstrapPresentation(snapshot.runtimeConfig)).toMatchObject({
        seamColor: undefined,
        environment: undefined,
        communityInvite: true,
      });
      expect(snapshot.runtimeIgnoredPaths).toContainEqual(["gateway", "controlUi", "environment"]);
      expect(snapshot.sourceConfig.gateway?.controlUi?.environment).toEqual(environment);
      expect(await fs.readFile(configPath, "utf8")).toBe(raw);
    },
  );

  it("preserves complete appearance settings and explicit invitation opt-out", async () => {
    const source = {
      ui: {
        seamColor: "#123456",
        prefs: { theme: "custom", themeMode: "system", accent: "theme" },
      },
      gateway: {
        controlUi: { communityInvite: false, environment: { label: "Preview", color: "red" } },
      },
    };
    const { io } = await configReader(source);
    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.valid).toBe(true);
    expect(snapshot.runtimeConfig.ui).toEqual(source.ui);
    expect(resolveControlUiBootstrapPresentation(snapshot.runtimeConfig)).toMatchObject({
      seamColor: "#123456",
      environment: source.gateway.controlUi.environment,
      communityInvite: false,
    });
  });

  it("recovers every invalid override beyond the ordinary diagnostic limit", async () => {
    const channels = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        String(200000000000000000n + BigInt(index)),
        { requireMention: "bad" },
      ]),
    );
    const { io } = await configReader({
      channels: {
        discord: {
          guilds: {
            "123456789012345678": { requireMention: false, channels },
          },
        },
      },
    });
    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
    const runtimeChannels =
      snapshot.runtimeConfig.channels?.discord?.guilds?.["123456789012345678"]?.channels;
    expect(Object.keys(runtimeChannels ?? {})).toHaveLength(20);
    expect(
      Object.values(runtimeChannels ?? {}).every((entry) => entry?.requireMention === undefined),
    ).toBe(true);
    expect(Object.values(channels).every((entry) => entry.requireMention === "bad")).toBe(true);
  });

  it.each(["false", 1, null])(
    "omits a bad mention override (%j) without disabling its channel",
    async (value) => {
      const source = {
        channels: {
          discord: {
            enabled: true,
            guilds: {
              "123456789012345678": {
                requireMention: false,
                channels: { "234567890123456789": { requireMention: value } },
              },
            },
            accounts: {
              work: {
                guilds: {
                  "345678901234567890": {
                    requireMention: value,
                    channels: { "456789012345678901": { requireMention: true } },
                  },
                },
              },
            },
          },
          slack: { channels: { general: { requireMention: value, replyToMode: "typo" } } },
        },
      };
      const { io, configPath, raw, logger } = await configReader(source);
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
      const discord = snapshot.runtimeConfig.channels?.discord;
      expect(discord?.enabled).toBe(true);
      expect(discord?.guilds?.["123456789012345678"]).toEqual({
        requireMention: false,
        channels: { "234567890123456789": {} },
      });
      expect(discord?.accounts?.work?.guilds?.["345678901234567890"]).toEqual({
        channels: { "456789012345678901": { requireMention: true } },
      });
      expect(snapshot.runtimeConfig.channels?.slack?.channels?.general).toEqual({});
      expect(snapshot.sourceConfig.channels).toEqual(source.channels);
      expect((await io.loadConfigAsync()).channels).toEqual(snapshot.runtimeConfig.channels);
      expect(await fs.readFile(configPath, "utf8")).toBe(raw);
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it("retains included settings and env references while existing defaults and inheritance apply", async () => {
    const { io, home, configPath, logger } = await configReader({});
    const included = JSON.stringify({
      messages: { ackReactionScope: "typo", responsePrefix: 42, ackReaction: "" },
      agents: {
        defaults: { typingMode: "never", humanDelay: { mode: "custom", minMs: 100, maxMs: 500 } },
        entries: { main: { typingMode: "typo", humanDelay: { minMs: -1, maxMs: 0 } } },
      },
    });
    const includePath = path.join(home, "preferences.json");
    await fs.writeFile(includePath, included);
    const raw =
      '{ // keep authored references\n $include: "preferences.json", gateway: { auth: { token: "${UNIT5_TOKEN}" } } }\n';
    await fs.writeFile(configPath, raw);
    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
    expect(snapshot.runtimeConfig.messages?.ackReactionScope).toBe("group-mentions");
    expect(snapshot.runtimeConfig.messages?.ackReaction).toBe("");
    expect(resolveResponsePrefix(snapshot.runtimeConfig, "main")).toBeUndefined();
    expect(resolveAgentConfig(snapshot.runtimeConfig, "main")?.typingMode).toBe("never");
    expect(resolveHumanDelayConfig(snapshot.runtimeConfig, "main")).toEqual({
      mode: "custom",
      minMs: 100,
      maxMs: 0,
    });
    expect(snapshot.runtimeConfig.gateway?.auth?.token).toBe("test-fixture-token");
    expect(snapshot.sourceConfig.messages?.responsePrefix).toBe(42);
    expect(await fs.readFile(configPath, "utf8")).toBe(raw);
    expect(await fs.readFile(includePath, "utf8")).toBe(included);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("uses presentation owners' fallbacks without deleting empty override objects", async () => {
    const { io } = await configReader({
      logging: { level: "typo", consoleLevel: false, consoleStyle: "typo" },
      channels: {
        discord: {
          textChunkLimit: 900,
          responsePrefix: "ROOT",
          markdown: { tables: "off" },
          streaming: { preview: { chunk: { minChars: 77, maxChars: 500 } } },
          accounts: {
            work: {
              textChunkLimit: -1,
              responsePrefix: 123,
              replyToMode: "typo",
              markdown: { tables: "typo" },
              streaming: {
                preview: { chunk: { minChars: 0, maxChars: null }, commandText: "raw" },
                progress: { commandText: "typo" },
              },
            },
          },
        },
      },
    });
    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
    const cfg = snapshot.runtimeConfig;
    expect(cfg.logging).toEqual({});
    expect(resolveTextChunkLimit(cfg, "discord", "work")).toBe(900);
    expect(resolveResponsePrefix(cfg, "main", { channel: "discord", accountId: "work" })).toBe(
      "ROOT",
    );
    expect(cfg.channels?.discord?.markdown?.tables).toBe("off");
    const account = cfg.channels?.discord?.accounts?.work;
    expect(account?.markdown).toEqual({});
    expect(account?.streaming?.preview?.chunk).toEqual({});
    expect(
      resolveChannelDraftStreamingChunking(cfg, "discord", "work", { fallbackLimit: 2000 }),
    ).toEqual({ minChars: 200, maxChars: 800, breakPreference: "paragraph" });
    expect(resolveChannelStreamingPreviewCommandText(account)).toBe("raw");
    expect(account?.replyToMode).toBeUndefined();
  });

  it("reports exact omitted paths for editors while authoring remains strict", () => {
    const source = {
      channels: {
        discord: {
          guilds: {
            "a/b~c.d": { requireMention: "false", futureSetting: true },
          },
        },
      },
    };
    const runtime = validateConfigObjectWithPlugins(source, { schemaValidation: "runtime" });
    expect(runtime.ok).toBe(true);
    if (!runtime.ok) {
      throw new Error("runtime candidate rejected");
    }
    expect(runtime.ignoredPaths).toEqual(
      expect.arrayContaining([
        ["channels", "discord", "guilds", "a/b~c.d", "requireMention"],
        ["channels", "discord", "guilds", "a/b~c.d", "futureSetting"],
      ]),
    );
    expect(source.channels.discord.guilds["a/b~c.d"].requireMention).toBe("false");
    expect(validateConfigObjectWithPlugins(source).ok).toBe(false);
  });

  it("retains finite execution defaults and opt-in feature disablement", async () => {
    const { io } = await configReader({
      agents: {
        defaults: { timeoutSeconds: -1, maxConcurrent: "many", subagents: { maxConcurrent: 0 } },
        entries: { main: {} },
      },
      diagnostics: { otel: { enabled: "yes" } },
    });
    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
    expect(resolveAgentTimeoutMs({ cfg: snapshot.runtimeConfig })).toBe(48 * 60 * 60 * 1000);
    expect(snapshot.runtimeConfig.agents?.defaults?.maxConcurrent).toBeGreaterThanOrEqual(8);
    expect(Number.isFinite(snapshot.runtimeConfig.agents?.defaults?.maxConcurrent)).toBe(true);
    expect(snapshot.runtimeConfig.agents?.defaults?.subagents?.maxConcurrent).toBe(8);
    expect(snapshot.runtimeConfig.diagnostics?.otel?.enabled).toBeUndefined();
  });

  it("inherits speech and media limits without inventing provider defaults or truncating audio", async () => {
    const { io } = await configReader({
      tts: { maxTextLength: -1, timeoutMs: 12000 },
      agents: { entries: { main: { tts: { timeoutMs: "bad" } } } },
      browser: { snapshotDefaults: { mode: "bad" } },
      channels: { feishu: { accounts: { work: { tts: { maxTextLength: "bad" } } } } },
      tools: {
        media: {
          concurrency: 0,
          image: { maxChars: 123, timeoutSeconds: 7 },
          audio: { maxChars: "bad", timeoutSeconds: "bad" },
          models: [{ provider: "fixture", model: "test", maxChars: "bad", timeoutSeconds: null }],
        },
      },
    });
    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
    const cfg = snapshot.runtimeConfig;
    expect(
      resolveTtsConfig(cfg, { agentId: "main", channelId: "feishu", accountId: "work" }),
    ).toMatchObject({ maxTextLength: 4096, timeoutMs: 12000, timeoutMsSource: "config" });
    expect(cfg.browser?.snapshotDefaults?.mode).toBeUndefined();
    expect(resolveConcurrency(cfg)).toBe(2);
    const entry = cfg.tools?.media?.models?.[0];
    expect(entry).toBeDefined();
    if (!entry) {
      throw new Error("media entry disappeared");
    }
    expect(resolveEntryRunOptions({ cfg, entry, capability: "image" })).toMatchObject({
      maxChars: 123,
      timeoutMs: 7000,
    });
    expect(resolveEntryRunOptions({ cfg, entry, capability: "audio" })).toMatchObject({
      maxChars: undefined,
      timeoutMs: 60000,
    });
    const noOverride = validateConfigObjectWithPlugins(
      { tts: { timeoutMs: "bad" } },
      { schemaValidation: "runtime" },
    );
    expect(noOverride.ok).toBe(true);
    if (!noOverride.ok) {
      throw new Error("speech default candidate rejected");
    }
    const config = resolveTtsConfig(noOverride.config);
    expect(config.timeoutMsSource).toBe("default");
    expect(resolveSpeechProviderTimeoutMs({ config, provider: { defaultTimeoutMs: 45000 } })).toBe(
      45000,
    );
  });

  it.each(["provider", "model"])(
    "inherits the supported model adapter after an invalid %s override",
    async (scope) => {
      const { io } = await configReader({
        models: {
          providers: {
            fixture: {
              baseUrl: "https://fixture.invalid",
              api: scope === "provider" ? "typo" : "anthropic-messages",
              models: [
                {
                  id: "test-model",
                  name: "Test",
                  api: scope === "model" ? "typo" : "anthropic-messages",
                  contextWindow: 16384,
                  contextTokens: "typo",
                  baseUrl: 123,
                },
                { id: "small-cap", name: "Small cap", contextWindow: 16384, contextTokens: 1 },
              ],
            },
          },
        },
      });
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
      const model = buildConfiguredFallbackModel({
        cfg: snapshot.runtimeConfig,
        provider: "fixture",
        modelId: "test-model",
        manifestAlias: { provider: "fixture" },
      });
      expect(model?.api).toBe("anthropic-messages");
      expect(model?.baseUrl).toBe("https://fixture.invalid");
      expect(model?.contextWindow).toBe(16384);
      expect(model?.contextTokens).toBeUndefined();
      expect(
        evaluateContextWindowGuard({
          info: resolveContextWindowInfo({
            cfg: snapshot.runtimeConfig,
            provider: "fixture",
            modelId: "small-cap",
            defaultTokens: 16384,
          }),
        }).shouldBlock,
      ).toBe(true);
    },
  );

  it.each([
    { gateway: { auth: { mode: "typo" } } },
    { session: { dmScope: "typo" } },
    { session: { maintenance: { maxDiskBytes: {} } } },
    { channels: { discord: { guilds: [] } } },
    { models: { providers: { fixture: { api: "typo", models: [] } } } },
    { tts: { auto: "bad" } },
    { tools: { media: { image: { scope: { default: "bad" } } } } },
    {
      gateway: {
        controlUi: { environment: { label: "Preview" }, allowExternalEmbedUrls: "false" },
      },
    },
    { gateway: { tailscale: { mode: "funnel" }, auth: { mode: "none" } } },
  ])("keeps required structure and policy errors blocking: %j", async (invalid) => {
    const { io, configPath, raw } = await configReader(invalid);
    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.valid).toBe(false);
    expect(snapshot.issues.some((issue) => !issue.path.startsWith("messages."))).toBe(true);
    await expect(io.loadConfigAsync()).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    expect(await fs.readFile(configPath, "utf8")).toBe(raw);
  });
});
