import { afterEach, expect, it, onTestFinished } from "vitest";
import { jsonResult } from "../agents/tools/common.js";
import { ensureGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { addTestHook } from "../plugins/hooks.test-helpers.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  isPluginRegistryRecordSetAdmitting,
  isPluginRegistryRetired,
  markPluginRegistryRetired,
} from "../plugins/registry-lifecycle.js";
import {
  commitStagedPluginRegistry,
  createPluginRegistryOwner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createCronScriptRuntimeFixture as createCronScriptRuntime } from "./trigger-script.test-helpers.js";

type PreparedRuntime = Awaited<
  ReturnType<NonNullable<Parameters<typeof createCronScriptRuntime>[0]["prepareRuntime"]>>
>;
const registries: ReturnType<typeof createEmptyPluginRegistry>[] = [];

afterEach(() => {
  registries.splice(0).forEach((registry) => markPluginRegistryRetired(registry));
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
    scheduledToolPolicy: undefined,
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

it("refreshes a cached runtime when a publication grows the plugin inventory", async () => {
  const first = preparePluginRuntime(1);
  const second = preparePluginRuntime(2);
  second.registry.plugins.push(createPluginRecord({ id: "extra" }));
  let prepares = 0;
  const disposed: number[] = [];
  const prepareRuntime = async () => {
    const current = ++prepares;
    const prepared = current === 1 ? first.prepared : second.prepared;
    return { ...prepared, [Symbol.dispose]: () => disposed.push(current) };
  };
  const runtime = createCronScriptRuntime({ config: {}, prepareRuntime });
  onTestFinished(() => resetPluginRuntimeStateForTest());
  // The Gateway owns the startup generation that the first preparation retains.
  setActivePluginRegistry(first.registry);
  createPluginRegistryOwner(first.registry);
  await expectGeneration(runtime, 1);
  await expectGeneration(runtime, 1);
  expect(prepares).toBe(1);
  // Enabling another plugin publishes a successor while the owner still holds
  // the retained registry: it stays unretired and admitting, but the active
  // version moves on.
  stageActivePluginRegistry(second.registry, null, "default");
  commitStagedPluginRegistry(first.registry, second.registry);
  expect(isPluginRegistryRetired(first.registry)).toBe(false);
  expect(isPluginRegistryRecordSetAdmitting(first.registry)).toBe(true);
  await expectGeneration(runtime, 2);
  expect(disposed).toEqual([1]);
  expect(prepares).toBe(2);
});

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
