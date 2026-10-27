import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { configFor, modelDefinition } from "../agents/model-auth.fixtures.test-support.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { logGatewayStartup } from "./server-startup-log.js";

const modelMocks = vi.hoisted(() => ({
  resolveThinkingDefault: vi.fn((): "medium" | "off" => "medium"),
}));
function createManifestRecord(
  overrides: Partial<PluginManifestRecord> & Pick<PluginManifestRecord, "id">,
): PluginManifestRecord {
  return {
    channels: [],
    cliBackends: [],
    hooks: [],
    manifestPath: `/tmp/${overrides.id}/openclaw.plugin.json`,
    origin: "global",
    providers: [],
    rootDir: `/tmp/${overrides.id}`,
    skills: [],
    source: `/tmp/${overrides.id}/index.js`,
    ...overrides,
  };
}

// Provider thinking owns a dedicated suite. Startup logging only needs its
// fixture-level default while proving precedence and banner composition.
vi.mock("../agents/model-thinking-default.js", () => ({
  resolveThinkingDefault: modelMocks.resolveThinkingDefault,
}));

async function startup(overrides: Partial<Parameters<typeof logGatewayStartup>[0]>) {
  const info = vi.fn<Parameters<typeof logGatewayStartup>[0]["log"]["info"]>();
  const warn = vi.fn();
  await logGatewayStartup({
    cfg: {},
    env: {},
    manifestRecords: [],
    loadedPluginIds: [],
    log: { info, warn },
    isNixMode: false,
    ...overrides,
  });
  return { info, warn };
}

type StartupConfig = Parameters<typeof logGatewayStartup>[0]["cfg"];
function modelCase(
  name: string,
  details: string,
  defaults: NonNullable<StartupConfig["agents"]>["defaults"] = {},
  cfg: StartupConfig = {},
  model = "openai/gpt-5.5",
) {
  return {
    name,
    expected: `agent model: ${model} (${details})`,
    cfg: { ...cfg, agents: { ...cfg.agents, defaults: { ...defaults, model } } },
  };
}

describe("gateway startup log", () => {
  it.each([false, true])(
    "logs the concrete owner's primary instead of its utility (ambient owner: %s)",
    async (ambientOwner) => {
      const { info } = await startup({
        cfg: {
          meta: { migrations: { utilityModelSeparation: true } },
          agents: {
            ownership: "explicit",
            ...(ambientOwner ? { defaults: { systemAgent: { agentId: "worker" } } } : {}),
            entries: {
              worker: {
                utilityModel: "helper@local:utility",
                models: { "local-utility/small": { alias: "helper" } },
              },
              ...(ambientOwner ? { other: {} } : {}),
            },
          },
          models: {
            providers: Object.fromEntries(
              ["local-utility", "ordinary"].map((provider) => [
                provider,
                {
                  baseUrl: "http://127.0.0.1:9/v1",
                  models: [
                    makeProviderModelFixture({
                      id: provider === "local-utility" ? "small" : "large",
                      provider,
                      api: "openai-completions",
                      baseUrl: "http://127.0.0.1:9/v1",
                    }),
                  ],
                },
              ]),
            ),
          },
        },
      });
      expect(info.mock.calls[0]?.[0]).toContain("agent model: ordinary/large");
    },
  );

  beforeEach(() => {
    modelMocks.resolveThinkingDefault.mockClear();
    modelMocks.resolveThinkingDefault.mockReturnValue("medium");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs version alignment guidance as information on ordinary startup", async () => {
    const { info, warn } = await startup({});

    expect(info).toHaveBeenCalledWith(
      "Older local CLI/SDK versions can bypass Gateway state mutation routing. Use matching CLI/SDK and Gateway versions; direct state writes from another process while this Gateway owns state are unsupported.",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when dangerous config flags are enabled", async () => {
    const { warn } = await startup({
      cfg: { hooks: { gmail: { allowUnsafeExternalContent: true } } },
    });

    expect(warn.mock.calls).toContainEqual([
      "security warning: dangerous config flags enabled: hooks.gmail.allowUnsafeExternalContent=true. Run `openclaw security audit`.",
    ]);
  });

  it("warns when a configured channel has no owning plugin", async () => {
    const { warn } = await startup({
      cfg: { channels: { "missing-chat": { enabled: true, token: "configured" } } },
    });

    expect(warn.mock.calls).toContainEqual([
      "configured channel warning: channels.missing-chat is configured but no channel plugin is installed or loadable (no-channel-owner). Run `openclaw doctor --fix` or install the channel plugin before relying on this channel.",
    ]);
  });

  it("logs one suppression notice without an ambient configured-channel warning", async () => {
    const manifestRecords = [
      createManifestRecord({
        id: "discord",
        channels: ["discord"],
        packageChannel: {
          id: "discord",
          configuredState: { env: { allOf: ["DISCORD_FAKE_TEST_TRIGGER"] } },
        },
        enabledByDefault: false,
      }),
    ];
    const { warn } = await startup({
      cfg: { plugins: { entries: { discord: { enabled: true } } } },
      env: { DISCORD_FAKE_TEST_TRIGGER: "configured" },
      manifestRecords,
      ambientEnvTriggers: "suppress",
    });

    expect(warn.mock.calls).toContainEqual([
      "gateway suppressed ambient channel auto-configuration for 1 channel: discord. Configure channels.<id> (openclaw channels add <id>) to enable the channel, or pass --ambient-channels to allow ambient env credentials.",
    ]);
    expect(warn.mock.calls.flat().join("\n")).not.toContain("channels.discord is configured");
  });

  it("sanitizes configured channel ids in startup warnings", async () => {
    const unsafeChannelId = `slack${String.fromCharCode(0x1b)}[31m`;
    const manifestRecords = [
      createManifestRecord({
        id: "slack",
        channels: [unsafeChannelId],
        enabledByDefault: false,
      }),
    ];
    const { warn } = await startup({
      cfg: { channels: { [unsafeChannelId]: { enabled: true, botToken: "configured" } } },
      manifestRecords,
    });

    const warnings = warn.mock.calls.flat().join("\n");
    expect(warnings).toContain("channels.slack: channel is configured");
    expect(warnings).not.toContain(String.fromCharCode(0x1b));
  });

  it("does not warn when startup activation enables the configured channel owner", async () => {
    const manifestRecords = [
      createManifestRecord({
        id: "openclaw-modern-chat",
        channels: ["legacy-chat"],
        enabledByDefault: false,
      }),
    ];
    const { warn } = await startup({
      cfg: { channels: { "legacy-chat": { enabled: true, token: "configured" } } },
      manifestRecords,
      activationSourceConfig: {
        plugins: { entries: { "openclaw-modern-chat": { enabled: true } } },
      },
    });

    expect(warn.mock.calls.flat().join("\n")).not.toContain("configured channel warning");
  });

  it.each([
    modelCase("configured model modes", "thinking=medium, fast=on", {
      models: { "openai/gpt-5.5": { params: { fastMode: true, thinking: "medium" } } },
      reasoningDefault: "stream",
    }),
    modelCase(
      "provider thinking default",
      "thinking=medium, fast=on",
      {},
      {
        agents: { entries: { main: { fastModeDefault: true } } },
      },
    ),
    modelCase("explicit thinking off", "thinking=off, fast=on", {
      models: { "openai/gpt-5.5": { params: { thinking: "off", fastMode: true } } },
    }),
    modelCase(
      "explicit Ultra",
      "thinking=ultra, fast=off",
      { thinkingDefault: "ultra" },
      {},
      "openai/gpt-5.6-sol",
    ),
    modelCase(
      "reasoning-disabled provider",
      "thinking=off, fast=off",
      {},
      configFor("google", "https://generativelanguage.googleapis.com/v1beta", {
        api: "google-generative-ai",
        models: [modelDefinition("gemma-4-26b-a4b-it", { reasoning: false })],
      }),
      "google/gemma-4-26b-a4b-it",
    ),
    modelCase(
      "agent mode overrides",
      "thinking=high, fast=on",
      {
        thinkingDefault: "low",
        reasoningDefault: "off",
        models: { "openai/gpt-5.5": { params: { fastMode: false } } },
      },
      { agents: { entries: { alpha: { thinkingDefault: "high", fastModeDefault: true } } } },
    ),
  ])("formats $name in startup model details", async ({ expected, cfg }) => {
    const { info } = await startup({ cfg });
    expect(info.mock.calls[0]?.[0]).toBe(expected);
    expect(stripAnsi(String(info.mock.calls[0]?.[1]?.consoleMessage))).toBe(expected);
  });

  it("logs a compact listening line with loaded plugin ids and duration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-03T10:00:16.000Z"));

    const { info } = await startup({
      loadedPluginIds: ["delta", "alpha", "delta", "beta"],
      startupStartedAt: Date.parse("2026-04-03T10:00:00.000Z"),
    });

    const listeningMessages = info.mock.calls
      .map((call) => call[0])
      .filter((message) => message.startsWith("http server listening ("));
    expect(listeningMessages).toEqual([
      "http server listening (3 plugins: alpha, beta, delta; 16.0s)",
    ]);
  });
});
