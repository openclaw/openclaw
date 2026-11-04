import { expect, it, vi } from "vitest";
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
    providerEndpoints: [{ endpointClass: "openai-public", hosts: ["api.openai.com"] }],
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
  [{ kind: "provider", provider: "openai-public" }, ["openai"]],
  [{ kind: "channel", channel: "telegram" }, ["demo-channel"]],
])("selects manifest owners for %j", (trigger, expected) => {
  expect(ids(trigger)).toEqual(expected);
});

it.each<[string, NonNullable<PlanParams["config"]>["plugins"], boolean, boolean]>([
  ["custom-harness", {}, false, true],
  ["custom-harness", { entries: { "custom-harness-plugin": { enabled: false } } }, false, false],
  ["custom-harness", { allow: ["legacy-custom-harness-plugin"] }, true, false],
  ["custom-harness", { allow: ["custom-harness-plugin"] }, true, true],
  ["load-path-harness", {}, true, true],
  ["load-path-harness", { deny: ["load-path-harness-plugin"] }, true, false],
])("applies %s activation policy %j with explicit trust=%s", (runtime, plugins, trust, allowed) => {
  expect(
    ids(
      { kind: "agentHarness", runtime },
      {
        config: { plugins },
        requireExplicitManifestOwnerTrust: trust,
      },
    ),
  ).toEqual(allowed ? [`${runtime}-plugin`] : []);
});

it("selects capabilities from explicit hints", () => {
  const manifestRecords = [
    owner({
      id: "explicit-provider",
      origin: "workspace",
      activation: { onCapabilities: ["provider"], onProviders: ["custom-provider"] },
    }),
  ];
  expect(ids({ kind: "capability", capability: "provider" }, { manifestRecords })).toEqual([
    "explicit-provider",
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
