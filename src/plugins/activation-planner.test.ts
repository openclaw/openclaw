import { describe, expect, it, vi } from "vitest";
import { resolveManifestActivationPluginIds } from "./activation-planner.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { createPluginManifestRecordFixture as owner } from "./plugin-metadata.test-support.js";

const loadRegistry = vi.hoisted(() => vi.fn());
// mock-isolation: Plan synthetic manifest records without discovering installed plugins.
vi.mock("./plugin-registry-contributions.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: loadRegistry,
}));

type PlanParams = Parameters<typeof resolveManifestActivationPluginIds>[0];
const manifests = [
  owner({
    id: "memory-core",
    commandAliases: [{ name: "dreaming", kind: "runtime-slash", cliCommand: "memory" }],
  }),
  owner({ id: "device-pair", commandAliases: [{ name: "pair", kind: "runtime-slash" }] }),
  owner({
    id: "browser",
    cliCommands: [{ name: "browser", description: "Manage the browser", hasSubcommands: true }],
  }),
  owner({
    id: "openai",
    providers: ["openai"],
    activation: { onAgentHarnesses: ["codex"] },
    setup: { providers: [{ id: "openai" }] },
  }),
  owner({
    id: "custom-harness-plugin",
    origin: "workspace",
    activation: { onAgentHarnesses: ["custom-harness"] },
  }),
  owner({
    id: "load-path-harness-plugin",
    origin: "config",
    activation: { onAgentHarnesses: ["load-path-harness"] },
  }),
  owner({
    id: "demo-channel",
    origin: "workspace",
    channels: ["telegram"],
    hooks: ["before-agent-start"],
    contracts: { tools: ["web-search"] },
    activation: { onRoutes: ["webhook"], onCommands: ["demo-tools"] },
  }),
];

function ids(trigger: PlanParams["trigger"], options: Omit<PlanParams, "trigger"> = {}) {
  return resolveManifestActivationPluginIds({ trigger, manifestRecords: manifests, ...options });
}

function expectHarness(
  runtime: string,
  expected: string[],
  options: Omit<PlanParams, "trigger"> = {},
) {
  expect(ids({ kind: "agentHarness", runtime }, options)).toEqual(expected);
}

describe("activation planner", () => {
  it("loads manifest ownership when no prepared records are supplied", () => {
    loadRegistry.mockReturnValue({ plugins: manifests, diagnostics: [] });
    expect(
      resolveManifestActivationPluginIds({ trigger: { kind: "command", command: "memory" } }),
    ).toEqual(["memory-core"]);
  });

  it.each<[PlanParams["trigger"], string[]]>([
    [{ kind: "command", command: "browser" }, ["browser"]],
    [{ kind: "command", command: "pair" }, ["device-pair"]],
    [{ kind: "command", command: "demo-tools" }, ["demo-channel"]],
    [{ kind: "capability", capability: "provider" }, ["openai"]],
    [{ kind: "capability", capability: "tool" }, ["demo-channel"]],
    [{ kind: "capability", capability: "hook" }, ["demo-channel"]],
    [{ kind: "agentHarness", runtime: "codex" }, ["openai"]],
    [{ kind: "route", route: "webhook" }, ["demo-channel"]],
    [{ kind: "provider", provider: "openai" }, ["openai"]],
    [{ kind: "channel", channel: "telegram" }, ["demo-channel"]],
  ])("selects manifest owners for %j", (trigger, expected) => {
    expect(ids(trigger)).toEqual(expected);
  });

  it("plans manifest-owned custom harnesses and respects their activation policy", () => {
    expectHarness("custom-harness", ["custom-harness-plugin"]);
    expectHarness("custom-harness", [], {
      config: { plugins: { entries: { "custom-harness-plugin": { enabled: false } } } },
    });
  });

  it("requires canonical ids for explicit manifest owner trust", () => {
    for (const [ownerId, expected] of [
      ["legacy-custom-harness-plugin", []],
      ["custom-harness-plugin", ["custom-harness-plugin"]],
    ] as const) {
      expectHarness("custom-harness", [...expected], {
        config: { plugins: { allow: [ownerId] } },
        requireExplicitManifestOwnerTrust: true,
      });
    }
  });

  it("treats load-path manifest owners as explicitly trusted for activation planning", () => {
    expectHarness("load-path-harness", ["load-path-harness-plugin"], {
      requireExplicitManifestOwnerTrust: true,
    });
    expectHarness("load-path-harness", [], {
      config: { plugins: { deny: ["load-path-harness-plugin"] } },
      requireExplicitManifestOwnerTrust: true,
    });
  });

  it("selects capabilities from explicit hints and manifest ownership", () => {
    const manifestRecords = [
      owner({
        id: "explicit-provider",
        origin: "workspace",
        activation: { onCapabilities: ["provider"], onProviders: ["custom-provider"] },
      }),
      owner({ id: "owned-tool", origin: "workspace", contracts: { tools: ["custom-tool"] } }),
    ];
    expect(ids({ kind: "capability", capability: "provider" }, { manifestRecords })).toEqual([
      "explicit-provider",
    ]);
    expect(ids({ kind: "capability", capability: "tool" }, { manifestRecords })).toEqual([
      "owned-tool",
    ]);
  });

  it("keeps unique sorted ids", () => {
    const manifestRecords: PluginManifestRecord[] = [
      owner({ id: "z-owner", activation: { onProviders: [" OPENAI "] } }),
      owner({
        id: "duplicate",
        origin: "workspace",
        providers: ["openai"],
        setup: { providers: [{ id: "OPENAI" }] },
      }),
      owner({ id: "a-owner", providers: ["OPENAI"] }),
      owner({ id: "duplicate", origin: "config", activation: { onProviders: ["openai"] } }),
    ];
    expect(ids({ kind: "provider", provider: " OpenAI " }, { manifestRecords })).toEqual([
      "a-owner",
      "duplicate",
      "z-owner",
    ]);
  });

  it("treats explicit empty plugin scopes as scoped-empty", () => {
    expect(ids({ kind: "provider", provider: "openai" }, { onlyPluginIds: [] })).toStrictEqual([]);
  });
});
