import { expect, it } from "vitest";
import { createRuntimePluginWork } from "../agents/runtime-plugin-work.js";
import { PluginInstance } from "./plugin-instance.js";
import { PluginInvocationScope } from "./plugin-invocation-scope.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { PluginRegistryInspectionResources } from "./registry-inspection-resources.js";

it("separates physical donor custody from exact caller work", async () => {
  const registry = createEmptyPluginRegistry();
  const donor = createEmptyPluginRegistry();
  const selected = new PluginInstance("same-plugin");
  const unused = new PluginInstance("same-plugin");
  registry.contextEngines.set("selected", {
    factory: selected.wrap(() => {
      throw new Error("not invoked");
    }),
    owner: "plugin:same-plugin",
    lifecycle: "runtime",
  });
  registry.contextEngines.set("unused", {
    factory: unused.wrap(() => {
      throw new Error("not invoked");
    }),
    owner: "plugin:same-plugin",
    lifecycle: "runtime",
  });
  const physical = new PluginRegistryInspectionResources(async () => {});
  const donorPhysical = new PluginRegistryInspectionResources(async () => {});
  physical.attach(registry);
  donorPhysical.attach(donor);
  const constructionWork = createRuntimePluginWork();
  const construction = new PluginInvocationScope(registry, [], { work: constructionWork });
  construction.run(() => physical.adoptInvocations(registry, donor));
  construction.release();
  constructionWork.release();
  const turnWork = createRuntimePluginWork();
  const turn = new PluginInvocationScope(registry, [], { work: turnWork });
  try {
    expect(selected.retainedWorkCount).toBe(0);
    expect(unused.retainedWorkCount).toBe(0);
    const invocation = turn.run(() => physical.createInvocationScope(registry, [selected]));
    try {
      invocation.wrap(registry.contextEngines.get("selected")!.factory);
      expect(turn.retainedInstances).toEqual([selected]);
      expect(invocation.retainedInstances).toEqual([selected]);
      expect(unused.retainedWorkCount).toBe(0);
    } finally {
      invocation.release();
    }
    expect(selected.retainedWorkCount).toBe(1);
  } finally {
    turn.release();
    turnWork.release();
    await physical.release();
    await donorPhysical.release();
    await Promise.all([selected.dispose(), unused.dispose()]);
  }
});
