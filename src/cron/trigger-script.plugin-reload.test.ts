import { afterEach, expect, it } from "vitest";
import { jsonResult } from "../agents/tools/common.js";
import { ensureGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { addTestHook } from "../plugins/hooks.test-helpers.js";
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

async function expectGeneration(
  runtime: ReturnType<typeof createCronScriptRuntime>,
  generation: number,
) {
  await expect(runtime.executePayload(request)).resolves.toMatchObject({
    kind: "completed",
    state: { generation },
  });
}

it.each(["registry", "hook plugin"] as const)(
  "refreshes a cached runtime after retiring its %s",
  async (retired) => {
    if (retired === "hook plugin") {
      ensureGlobalHookRunner();
    }
    let generation = 0;
    const disposed: number[] = [];
    const guarded: number[] = [];
    const guards: PluginInstance[] = [];
    const prepareRuntime = async () => {
      const current = ++generation;
      const { prepared, registry } = preparePluginRuntime(current);
      if (retired === "hook plugin") {
        const record = createPluginRecord({ id: "guard" });
        registry.plugins.push(record);
        const guard = new PluginInstance("guard", { record, registry });
        guards.push(guard);
        addTestHook({
          registry,
          pluginId: "guard",
          hookName: "before_tool_call",
          handler: guard.wrap(async () => {
            guarded.push(current);
            return undefined;
          }),
        });
      }
      return {
        ...prepared,
        [Symbol.dispose]: () => disposed.push(current),
      };
    };
    const runtime = createCronScriptRuntime({ config: {}, prepareRuntime });
    await expectGeneration(runtime, 1);
    if (retired === "registry") {
      markPluginRegistryRetired(registries[0]);
    } else {
      // Replacing one plugin leaves its registry retained and unretired.
      await guards[0]?.dispose();
      expect(guards).toHaveLength(1);
    }
    await expectGeneration(runtime, 2);
    expect(disposed).toEqual([1]);
    expect(guarded).toEqual(retired === "hook plugin" ? [1, 2] : []);
  },
);

it("never replays a script that fails after a tool effect and plugin retirement", async () => {
  let effects = 0;
  const current = preparePluginRuntime(1, () => {
    effects += 1;
    current.instance.quiesce();
    return current.instance.wrap(() => jsonResult({ generation: 1 }))();
  });
  const prepareRuntime = async () => current.prepared;
  const runtime = createCronScriptRuntime({ config: {}, prepareRuntime });
  await expect(
    runtime.executePayload({
      ...request,
      script: "await probe({}); throw new Error('stopped after effect');",
    }),
  ).resolves.toMatchObject({ kind: "error" });
  expect(effects).toBe(1);
});
