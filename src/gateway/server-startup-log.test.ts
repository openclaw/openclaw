// Startup log tests cover security warnings, model detail formatting, plugin
// summaries, ANSI output, and dangerous config reporting.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { formatAgentModelStartupDetails, logGatewayStartup } from "./server-startup-log.js";

const modelMocks = vi.hoisted(() => ({
  resolveThinkingDefault: vi.fn(() => "medium" as const),
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
  const info = vi.fn();
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

describe("gateway startup log", () => {
  it.each([true])(
    "logs the concrete owner's primary instead of its utility (ambient owner: %s)",
    async (ambientOwner) => {
      const info = vi.fn();
      await logGatewayStartup({
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
        env: {},
        manifestRecords: [],
        loadedPluginIds: [],
        log: { info, warn: vi.fn() },
        isNixMode: false,
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
      cfg: {
        channels: {
          "missing-chat": {
            enabled: true,
            token: "configured",
          },
        },
      },
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
      cfg: {
        plugins: {
          entries: { discord: { enabled: true } },
        },
      },
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
      cfg: {
        channels: {
          [unsafeChannelId]: {
            enabled: true,
            botToken: "configured",
          },
        },
      },
      manifestRecords,
    });

    const warnings = warn.mock.calls.flat().join("\n");
    expect(warnings).toContain("channels.slack: channel is configured");
    expect(warnings).not.toContain(String.fromCharCode(0x1b));
  });

  it("defaults unset startup thinking to medium", () => {
    expect(
      formatAgentModelStartupDetails({
        cfg: {
          agents: {
            defaults: {
              model: "openai/gpt-5.5",
            },
            entries: { main: { fastModeDefault: true } },
          },
        },
        provider: "openai",
        model: "gpt-5.5",
      }),
    ).toBe("thinking=medium, fast=on");
    expect(modelMocks.resolveThinkingDefault).toHaveBeenCalledTimes(1);
  });

  it("shows thinking off for configured provider models with reasoning disabled", () => {
    expect(
      formatAgentModelStartupDetails({
        cfg: {
          models: {
            providers: {
              google: {
                api: "google-generative-ai",
                baseUrl: "https://generativelanguage.googleapis.com/v1beta",
                models: [
                  {
                    id: "gemma-4-26b-a4b-it",
                    name: "Gemma 4 26B",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 32_000,
                    maxTokens: 8_192,
                  },
                ],
              },
            },
          },
        },
        provider: "google",
        model: "gemma-4-26b-a4b-it",
      }),
    ).toBe("thinking=off, fast=off");
    expect(modelMocks.resolveThinkingDefault).not.toHaveBeenCalled();
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
    const messages = info.mock.calls.map((call) => call[0]);
    const nativeRuntime = messages.find((message) => message.startsWith("native runtime: "));
    expect(JSON.parse(nativeRuntime!.slice("native runtime: ".length))).toMatchObject({
      pid: process.pid,
      node: process.versions.node,
      sqlite: process.versions.sqlite,
      uv: process.versions.uv,
      openssl: process.versions.openssl,
    });
    const workers = messages.find((message) => message.startsWith("worker startup state: "));
    expect(JSON.parse(workers!.slice("worker startup state: ".length))).toMatchObject({
      workerCount: expect.any(Number),
      workerLifecycle: expect.any(Array),
      compute: { limit: expect.any(Number), active: 0, pendingTasks: 0 },
    });
  });
});
