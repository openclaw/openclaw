import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPluginManifestRegistry: vi.fn(),
}));

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistry: (...args: unknown[]) => mocks.loadPluginManifestRegistry(...args),
}));

let resolveManifestActivationPluginIds: typeof import("./activation-planner.js").resolveManifestActivationPluginIds;
let resolveManifestActivationPlan: typeof import("./activation-planner.js").resolveManifestActivationPlan;
let PLUGIN_COMPAT_REASON: typeof import("./compat-reasons.js").PLUGIN_COMPAT_REASON;

describe("resolveManifestActivationPluginIds", () => {
  beforeAll(async () => {
    ({ resolveManifestActivationPluginIds, resolveManifestActivationPlan } =
      await import("./activation-planner.js"));
    ({ PLUGIN_COMPAT_REASON } = await import("./compat-reasons.js"));
  });

  beforeEach(() => {
    mocks.loadPluginManifestRegistry.mockReset();
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "memory-core",
          commandAliases: [{ name: "dreaming", kind: "runtime-slash", cliCommand: "memory" }],
          providers: [],
          channels: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          origin: "bundled",
        },
        {
          id: "device-pair",
          commandAliases: [{ name: "pair", kind: "runtime-slash" }],
          providers: [],
          channels: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          origin: "bundled",
        },
        {
          id: "openai",
          providers: ["openai"],
          activation: {
            onAgentHarnesses: ["codex"],
          },
          setup: {
            providers: [{ id: "openai-codex" }],
          },
          channels: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          origin: "bundled",
        },
        {
          id: "demo-channel",
          channels: ["telegram"],
          providers: [],
          cliBackends: [],
          skills: [],
          hooks: ["before-agent-start"],
          contracts: {
            tools: ["web-search"],
          },
          activation: {
            onRoutes: ["webhook"],
            onCommands: ["demo-tools"],
          },
          origin: "workspace",
        },
        {
          id: "legacy-activation-only",
          providers: [],
          activation: {
            onProviders: ["legacy-provider"],
            onChannels: ["legacy-channel"],
            onCapabilities: ["tool"],
          },
          channels: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          origin: "workspace",
        },
      ],
      diagnostics: [],
    });
  });

  it("matches command triggers from activation metadata and legacy command aliases", () => {
    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "command",
          command: "memory",
        },
      }),
    ).toEqual(["memory-core"]);

    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "command",
          command: "pair",
        },
      }),
    ).toEqual(["device-pair"]);

    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "command",
          command: "demo-tools",
        },
      }),
    ).toEqual(["demo-channel"]);
  });

  it("matches provider, agent harness, channel, and route triggers from manifest-owned metadata", () => {
    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "provider",
          provider: "openai",
        },
      }),
    ).toEqual(["openai"]);

    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "provider",
          provider: "openai-codex",
        },
      }),
    ).toEqual(["openai"]);

    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "agentHarness",
          runtime: "codex",
        },
      }),
    ).toEqual(["openai"]);

    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "channel",
          channel: "telegram",
        },
      }),
    ).toEqual(["demo-channel"]);

    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "route",
          route: "webhook",
        },
      }),
    ).toEqual(["demo-channel"]);
  });

  it("matches capability triggers from explicit hints or existing manifest ownership", () => {
    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "capability",
          capability: "provider",
        },
      }),
    ).toEqual(["openai"]);

    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "capability",
          capability: "tool",
        },
      }),
    ).toEqual(["demo-channel", "legacy-activation-only"]);

    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "capability",
          capability: "hook",
        },
      }),
    ).toEqual(["demo-channel"]);
  });

  it("treats explicit empty plugin scopes as scoped-empty", () => {
    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "provider",
          provider: "openai",
        },
        onlyPluginIds: [],
      }),
    ).toEqual([]);
  });

  it("reports legacy activation field compat reasons without changing plugin-id resolution", () => {
    expect(
      resolveManifestActivationPlan({
        trigger: {
          kind: "command",
          command: "demo-tools",
        },
      }),
    ).toEqual({
      pluginIds: ["demo-channel"],
      entries: [
        {
          pluginId: "demo-channel",
          reasons: ["command:demo-tools"],
          compatReasons: [PLUGIN_COMPAT_REASON.legacyActivationField],
        },
      ],
      compatReasons: {
        "demo-channel": [PLUGIN_COMPAT_REASON.legacyActivationField],
      },
    });

    expect(
      resolveManifestActivationPlan({
        trigger: {
          kind: "provider",
          provider: "legacy-provider",
        },
      }).compatReasons,
    ).toEqual({
      "legacy-activation-only": [PLUGIN_COMPAT_REASON.legacyActivationField],
    });

    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "provider",
          provider: "legacy-provider",
        },
      }),
    ).toEqual(["legacy-activation-only"]);
  });

  it("does not report compat reasons for stable ownership metadata", () => {
    expect(
      resolveManifestActivationPlan({
        trigger: {
          kind: "provider",
          provider: "openai",
        },
      }),
    ).toEqual({
      pluginIds: ["openai"],
      entries: [
        {
          pluginId: "openai",
          reasons: ["provider:openai"],
          compatReasons: [],
        },
      ],
      compatReasons: {},
    });
  });

  it("reports legacy activation capability hints separately from stable capabilities", () => {
    expect(
      resolveManifestActivationPlan({
        trigger: {
          kind: "capability",
          capability: "tool",
        },
      }),
    ).toEqual({
      pluginIds: ["demo-channel", "legacy-activation-only"],
      entries: [
        {
          pluginId: "demo-channel",
          reasons: ["capability:tool"],
          compatReasons: [],
        },
        {
          pluginId: "legacy-activation-only",
          reasons: ["capability:tool"],
          compatReasons: [PLUGIN_COMPAT_REASON.legacyActivationField],
        },
      ],
      compatReasons: {
        "legacy-activation-only": [PLUGIN_COMPAT_REASON.legacyActivationField],
      },
    });
  });
});
