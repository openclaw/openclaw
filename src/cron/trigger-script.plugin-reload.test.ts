import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdmittedRunContext } from "../agents/admitted-run-context.js";
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
  const createTools = instance.wrap(() => [
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
  it.each(["between checks", "during admission"] as const)(
    "uses current tools when the plugin retires %s without changing config",
    async (when) => {
      let generation = 0;
      const prepareRuntime = vi.fn(async () => preparePluginRuntime(++generation).prepared);
      const admissions: AdmittedRunContext[] = [];
      const started = vi.fn();
      const runtime = createCronScriptRuntime({ config: {}, prepareRuntime });
      if (when === "between checks") {
        await expect(runtime.executePayload(request)).resolves.toMatchObject({
          kind: "completed",
          state: { generation: 1 },
        });
        markPluginRegistryRetired(registries[0]);
      }
      await expect(
        runtime.executePayload({
          ...request,
          executionIdentity: {
            ingress: { kind: "schedule", boundary: "cron.script", state: "present" },
            onPostAdmission: (admitted) => {
              admissions.push(admitted);
              if (when === "during admission") {
                markPluginRegistryRetired(registries[0]);
              }
            },
            onExecutionStarted: started,
          },
        }),
      ).resolves.toMatchObject({ kind: "completed", state: { generation: 2 } });
      expect(prepareRuntime).toHaveBeenCalledTimes(2);
      expect(admissions).toHaveLength(1);
      expect(started).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])("bounds setup recovery when repeated retirement=%s", async (repeat) => {
    let generation = 0;
    const prepareRuntime = vi.fn(async () => {
      const { prepared, instance } = preparePluginRuntime(++generation);
      return {
        ...prepared,
        createTools: (...args: Parameters<PreparedRuntime["createTools"]>) => {
          if (repeat || generation === 1) {
            instance.quiesce();
          }
          return prepared.createTools(...args);
        },
      };
    });
    const started = vi.fn();
    const runtime = createCronScriptRuntime({ config: {}, prepareRuntime });
    await expect(
      runtime.executePayload({
        ...request,
        executionIdentity: {
          ingress: { kind: "schedule", boundary: "cron.script", state: "present" },
          onExecutionStarted: started,
        },
      }),
    ).resolves.toMatchObject(
      repeat
        ? { kind: "error", code: "plugin_reload_failed" }
        : { kind: "completed", state: { generation: 2 } },
    );
    expect(prepareRuntime).toHaveBeenCalledTimes(2);
    expect(started).toHaveBeenCalledTimes(repeat ? 0 : 1);
  });

  it.each(["preparation error", "another retirement"])(
    "reports failed automatic recovery when a cached runtime refresh hits %s",
    async (failure) => {
      let generation = 0;
      const prepareRuntime = vi.fn(async () => {
        generation += 1;
        if (generation > 1 && failure === "preparation error") {
          throw new Error("Fixture plugin could not load");
        }
        const current = preparePluginRuntime(generation);
        if (generation > 1) {
          current.instance.quiesce();
        }
        return current.prepared;
      });
      const runtime = createCronScriptRuntime({ config: {}, prepareRuntime });
      await expect(runtime.executePayload(request)).resolves.toMatchObject({ kind: "completed" });
      markPluginRegistryRetired(registries[0]);
      const started = vi.fn();
      await expect(
        runtime.executePayload({
          ...request,
          executionIdentity: {
            ingress: { kind: "schedule", boundary: "cron.script", state: "present" },
            onExecutionStarted: started,
          },
        }),
      ).resolves.toMatchObject({ kind: "error", code: "plugin_reload_failed" });
      expect(prepareRuntime).toHaveBeenCalledTimes(2);
      expect(started).not.toHaveBeenCalled();
    },
  );

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
