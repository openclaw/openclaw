/** Tests manifest activation planning for commands, providers, channels, and capabilities. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPluginManifestRegistryForPluginRegistry: vi.fn(),
}));

vi.mock("./plugin-registry-contributions.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: (...args: unknown[]) =>
    mocks.loadPluginManifestRegistryForPluginRegistry(...args),
}));

let resolveManifestActivationPluginIds: typeof import("./activation-planner.js").resolveManifestActivationPluginIds;
type PlanParams = Parameters<typeof resolveManifestActivationPluginIds>[0];
function ids(trigger: PlanParams["trigger"], options: Omit<PlanParams, "trigger"> = {}) {
  return resolveManifestActivationPluginIds({ trigger, ...options });
}

function mockRegistry(plugins: Record<string, unknown>[]) {
  mocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
    plugins: plugins.map((plugin) =>
      Object.assign(
        { providers: [], channels: [], cliBackends: [], skills: [], hooks: [] },
        plugin,
      ),
    ),
    diagnostics: [],
  });
}

describe("activation planner", () => {
  beforeAll(async () => {
    ({ resolveManifestActivationPluginIds } = await import("./activation-planner.js"));
  });

  beforeEach(() => {
    mocks.loadPluginManifestRegistryForPluginRegistry.mockReset();
    mockRegistry([
      {
        id: "memory-core",
        commandAliases: [{ name: "dreaming", kind: "runtime-slash", cliCommand: "memory" }],
        origin: "bundled",
      },
      {
        id: "device-pair",
        commandAliases: [{ name: "pair", kind: "runtime-slash" }],
        origin: "bundled",
      },
      {
        id: "browser",
        cliCommands: [
          {
            name: "browser",
            description: "Manage the browser",
            hasSubcommands: true,
          },
        ],
        origin: "bundled",
      },
      {
        id: "openai",
        providers: ["openai"],
        activation: {
          onAgentHarnesses: ["codex"],
        },
        setup: {
          providers: [{ id: "openai" }],
        },
        origin: "bundled",
      },
      {
        id: "custom-harness-plugin",
        activation: {
          onAgentHarnesses: ["custom-harness"],
        },
        origin: "workspace",
      },
      {
        id: "load-path-harness-plugin",
        activation: {
          onAgentHarnesses: ["load-path-harness"],
        },
        origin: "config",
      },
      {
        id: "demo-channel",
        channels: ["telegram"],
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
    ]);
  });

  it("keeps ids-only command planning stable", () => {
    expect(ids({ kind: "command", command: "memory" })).toEqual(["memory-core"]);
    expect(ids({ kind: "command", command: "browser" })).toEqual(["browser"]);
    expect(ids({ kind: "command", command: "pair" })).toEqual(["device-pair"]);
    expect(ids({ kind: "command", command: "demo-tools" })).toEqual(["demo-channel"]);
  });

  it("plans manifest-owned custom harnesses and respects their activation policy", () => {
    const trigger = { kind: "agentHarness", runtime: "custom-harness" } as const;
    expect(ids(trigger)).toEqual(["custom-harness-plugin"]);

    expect(
      ids(trigger, {
        config: { plugins: { entries: { "custom-harness-plugin": { enabled: false } } } },
      }),
    ).toEqual([]);
  });

  it("requires canonical ids for explicit manifest owner trust", () => {
    const trigger = { kind: "agentHarness", runtime: "custom-harness" } as const;
    expect(
      ids(trigger, {
        config: { plugins: { allow: ["legacy-custom-harness-plugin"] } },
        requireExplicitManifestOwnerTrust: true,
      }),
    ).toEqual([]);

    expect(
      ids(trigger, {
        config: { plugins: { allow: ["custom-harness-plugin"] } },
        requireExplicitManifestOwnerTrust: true,
      }),
    ).toEqual(["custom-harness-plugin"]);
  });

  it("treats load-path manifest owners as explicitly trusted for activation planning", () => {
    const trigger = { kind: "agentHarness", runtime: "load-path-harness" } as const;
    expect(
      ids(trigger, {
        requireExplicitManifestOwnerTrust: true,
      }),
    ).toEqual(["load-path-harness-plugin"]);

    expect(
      ids(trigger, {
        config: { plugins: { deny: ["load-path-harness-plugin"] } },
        requireExplicitManifestOwnerTrust: true,
      }),
    ).toEqual([]);
  });

  it("keeps ids-only capability planning stable", () => {
    expect(ids({ kind: "capability", capability: "provider" })).toEqual(["openai"]);
    expect(ids({ kind: "capability", capability: "tool" })).toEqual(["demo-channel"]);
    expect(ids({ kind: "capability", capability: "hook" })).toEqual(["demo-channel"]);
  });

  it("selects harness and route owners from activation hints", () => {
    expect(ids({ kind: "agentHarness", runtime: "codex" })).toEqual(["openai"]);
    expect(ids({ kind: "route", route: "webhook" })).toEqual(["demo-channel"]);
  });

  it("selects manifest owners when activation hints are absent", () => {
    expect(ids({ kind: "provider", provider: "openai" })).toEqual(["openai"]);
    expect(ids({ kind: "channel", channel: "telegram" })).toEqual(["demo-channel"]);
  });

  it("selects capabilities from explicit hints and manifest ownership", () => {
    mockRegistry([
      {
        id: "explicit-provider",
        activation: {
          onCapabilities: ["provider"],
          onProviders: ["custom-provider"],
        },
        origin: "workspace",
      },
      {
        id: "owned-tool",
        contracts: {
          tools: ["custom-tool"],
        },
        origin: "workspace",
      },
    ]);

    expect(ids({ kind: "capability", capability: "provider" })).toEqual(["explicit-provider"]);
    expect(ids({ kind: "capability", capability: "tool" })).toEqual(["owned-tool"]);
  });

  it("keeps unique sorted ids", () => {
    mocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      plugins: [
        { id: "z-owner", origin: "bundled", activation: { onProviders: [" OPENAI "] } },
        {
          id: "duplicate",
          origin: "workspace",
          providers: ["openai"],
          setup: { providers: [{ id: "OPENAI" }] },
        },
        { id: "a-owner", origin: "bundled", providers: ["OPENAI"] },
        { id: "duplicate", origin: "config", activation: { onProviders: ["openai"] } },
      ],
      diagnostics: [],
    });
    const trigger = { kind: "provider" as const, provider: " OpenAI " };
    expect(resolveManifestActivationPluginIds({ trigger })).toEqual([
      "a-owner",
      "duplicate",
      "z-owner",
    ]);
  });

  it("treats explicit empty plugin scopes as scoped-empty", () => {
    expect(ids({ kind: "provider", provider: "openai" }, { onlyPluginIds: [] })).toStrictEqual([]);
  });
});
