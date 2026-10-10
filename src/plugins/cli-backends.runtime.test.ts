import { afterEach, describe, expect, it } from "vitest";
import {
  listCliRuntimeModelBackendBindings,
  resolveCliBackendConfig,
  resolveCliRuntimeCanonicalProvider,
} from "../agents/cli-backends.js";
import { retainCliPluginExecutionConsumer } from "../agents/cli-runner/execution-target.js";
import { isCliProvider } from "../agents/model-selection-cli.js";
import type { CliBackendExecuteContextV2 } from "./cli-backend.types.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createRuntimeTestRegistry } from "./registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";
import { createPluginRecord } from "./status.test-helpers.js";

describe("runtime CLI backend consumers", () => {
  const owners: NonNullable<ReturnType<typeof getPluginInstance>>[] = [];

  afterEach(async () => {
    for (const owner of owners) {
      await owner.dispose();
    }
    owners.length = 0;
    resetPluginRuntimeStateForTest();
  });

  function registerBackend(provider: string) {
    const builder = createRuntimeTestRegistry(createPluginRuntime());
    const record = createPluginRecord({ id: provider });
    const api = builder.createApi(record, { config: {} });
    api.registerCliBackend({
      id: "fixture-cli",
      modelProvider: provider,
      config: { command: `${provider}-cli` },
      resolveModelId: ({ modelId }) => `${provider}:${modelId}`,
      subscriptionAuthDispatch: true,
      prepareExecutionV2: () => ({
        async *execute(context) {
          await context.prepareExecutionAdmission();
          yield { type: "result", provider };
        },
      }),
    });
    const owner = getPluginInstance(record);
    if (!owner) {
      throw new Error("Expected the registered CLI backend to have an instance");
    }
    owners.push(owner);
    return { builder, owner };
  }

  it("refreshes display metadata while retained execution hooks stay with their owner", async () => {
    const first = registerBackend("first-provider");
    setActivePluginRegistry(first.builder.registry);

    expect(isCliProvider(" FIXTURE-CLI ")).toBe(true);
    expect(resolveCliRuntimeCanonicalProvider({ runtime: "fixture-cli" })).toBe("first-provider");
    expect(listCliRuntimeModelBackendBindings()).toEqual([
      { provider: "first-provider", runtime: "fixture-cli" },
    ]);
    const retained = resolveCliBackendConfig("fixture-cli");
    expect(retained?.config.command).toBe("first-provider-cli");
    expect(retained?.resolveModelId?.({ modelId: "demo" })).toBe("first-provider:demo");

    const second = registerBackend("second-provider");
    setActivePluginRegistry(second.builder.registry);
    await first.owner.dispose();

    expect(resolveCliRuntimeCanonicalProvider({ runtime: "fixture-cli" })).toBe("second-provider");
    expect(listCliRuntimeModelBackendBindings()).toEqual([
      { provider: "second-provider", runtime: "fixture-cli" },
    ]);
    expect(resolveCliBackendConfig("fixture-cli")?.config.command).toBe("second-provider-cli");
    expect(() => retained?.resolveModelId?.({ modelId: "demo" })).toThrow(
      /reloaded|disabled|retir/i,
    );
  });

  it("retains V2 factory transports through retirement and closes them with their consumer", async () => {
    const registered = registerBackend("factory-provider");
    setActivePluginRegistry(registered.builder.registry);
    const backend = resolveCliBackendConfig("fixture-cli");
    const prepared = await backend?.prepareExecutionV2?.({
      workspaceDir: "/tmp",
      provider: "factory-provider",
      modelId: "fixture-model",
    });
    const execute = prepared?.execute;
    const consumer = retainCliPluginExecutionConsumer(execute);
    if (!execute || !consumer) {
      throw new Error("The V2 prepared transport must retain its registered plugin owner");
    }
    const context: CliBackendExecuteContextV2 = {
      command: "/bin/true",
      args: [],
      cwd: "/tmp",
      env: {},
      prompt: "synthetic",
      modelId: "fixture-model",
      systemPrompt: "synthetic",
      useResume: false,
      timeoutMs: 1000,
      prepareExecutionAdmission: async () => {},
      requestToolPermission: async () => ({ behavior: "deny", message: "No fixture tools." }),
      requestUserInput: async () => ({ status: "cancelled", message: "No fixture input." }),
    };
    const consume = async () => {
      const records = [];
      for await (const record of execute(context)) {
        records.push(record);
      }
      return records;
    };
    try {
      registered.owner.quiesce();
      await expect(consumer.run(consume)).resolves.toEqual([
        { type: "result", provider: "factory-provider" },
      ]);
    } finally {
      consumer.release();
      await registered.owner.dispose();
    }
    await expect(consume()).rejects.toThrow(/reloaded|disabled|retir|closed/i);
  });

  it("keeps request-scoped CLI ownership ahead of the ambient registry", async () => {
    const ambient = registerBackend("ambient-provider");
    const scoped = registerBackend("scoped-provider");
    setActivePluginRegistry(ambient.builder.registry);
    await withPluginRuntimeRegistryScope(scoped.builder.registry, async () => {
      await Promise.resolve();
      expect(resolveCliRuntimeCanonicalProvider({ runtime: "fixture-cli" })).toBe(
        "scoped-provider",
      );
      expect(resolveCliBackendConfig("fixture-cli")?.config.command).toBe("scoped-provider-cli");
    });
    expect(resolveCliRuntimeCanonicalProvider({ runtime: "fixture-cli" })).toBe("ambient-provider");
  });
});
