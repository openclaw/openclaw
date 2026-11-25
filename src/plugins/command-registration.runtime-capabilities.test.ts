import { expect, it } from "vitest";
import type { PluginCommandRuntimeCapability } from "./plugin-command.types.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createBundledPluginRecord } from "./status.test-fixtures.js";

it("validates and stores one copy of caller-owned runtime capabilities", () => {
  const pluginRegistry = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: true,
  });
  const record = {
    ...createBundledPluginRecord("scheduling-plugin"),
    origin: "workspace" as const,
    source: "/workspace/scheduling-plugin/index.ts",
    rootDir: "/workspace/scheduling-plugin",
    contracts: { commandRuntimeCapabilities: ["subagents", "scheduledTurns"] },
  };
  // A caller array can hide a capability from membership checks; the host must not ask it.
  const forged: PluginCommandRuntimeCapability[] = ["subagents", "scheduledTurns"];
  Object.defineProperty(forged, "includes", { value: () => false });
  pluginRegistry.registerCommand(record, {
    name: "forged-schedule",
    description: "Forged scheduled command",
    requireAuth: true,
    runtimeCapabilities: forged,
    handler: async () => ({ text: "never registered" }),
  });
  expect(
    pluginRegistry.registry.commands.filter((entry) => entry.command.name === "forged-schedule"),
  ).toEqual([]);
  expect(
    pluginRegistry.registry.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
  ).toContain("contracts.sessionScheduledTurns");
});
