import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../agents/tools/common.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { markPluginRegistryRetired } from "../plugins/registry-lifecycle.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createCronScriptRuntimeFixture as createCronScriptRuntime } from "./trigger-script.test-helpers.js";

type PreparedRuntime = Awaited<
  ReturnType<NonNullable<Parameters<typeof createCronScriptRuntime>[0]["prepareRuntime"]>>
>;
const registries: ReturnType<typeof createEmptyPluginRegistry>[] = [];

afterEach(() => {
  registries.splice(0).forEach(markPluginRegistryRetired);
});

function preparePluginRuntime(generation: number, execute = () => jsonResult({ generation })) {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "probe" });
  registry.plugins.push(record);
  registries.push(registry);
  const instance = new PluginInstance("probe", { record, registry });
  const createTools = instance.wrap(async () => [
    {
      name: "probe",
      label: "Probe",
      description: "Observe the plugin generation",
      parameters: { type: "object", properties: {} },
      execute: async () => execute(),
    },
  ]);
  const prepared: PreparedRuntime = {
    pluginRegistry: registry,
    context: { config: {}, agentId: "main", sessionKey: "agent:main:cron:reload:trigger" },
    createTools,
  };
  return { prepared, instance, registry };
}

const request = { jobId: "reload", script: "return { state: await probe({}) };", state: null };

describe("automation plugin reload recovery", () => {
  it("refreshes a retired cached runtime on the next invocation", async () => {
    let generation = 0;
    const disposed: number[] = [];
    const prepareRuntime = vi.fn(async () => {
      const current = ++generation;
      return {
        ...preparePluginRuntime(current).prepared,
        [Symbol.dispose]: () => disposed.push(current),
      };
    });
    const runtime = createCronScriptRuntime({ config: {}, prepareRuntime });
    await expect(runtime.executePayload(request)).resolves.toMatchObject({
      kind: "completed",
      state: { generation: 1 },
    });
    markPluginRegistryRetired(registries[0]);
    await expect(runtime.executePayload(request)).resolves.toMatchObject({
      kind: "completed",
      state: { generation: 2 },
    });
    expect(prepareRuntime).toHaveBeenCalledTimes(2);
    expect(disposed).toEqual([1]);
  });

  it("never replays a script that fails after a tool effect and plugin retirement", async () => {
    let effects = 0;
    const current = preparePluginRuntime(1, () => {
      effects += 1;
      current.instance.quiesce();
      return current.instance.wrap(() => jsonResult({ generation: 1 }))();
    });
    const prepareRuntime = vi.fn(async () => current.prepared);
    const runtime = createCronScriptRuntime({ config: {}, prepareRuntime });
    await expect(
      runtime.executePayload({
        ...request,
        script: "await probe({}); throw new Error('stopped after effect');",
      }),
    ).resolves.toMatchObject({ kind: "error" });
    expect(effects).toBe(1);
    expect(prepareRuntime).toHaveBeenCalledOnce();
  });
});
