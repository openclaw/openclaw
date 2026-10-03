import { Command, Option } from "commander";
import { expect, it } from "vitest";
import { createPluginRuntimeStore } from "../plugin-sdk/runtime-store.js";
import { createPluginRecord } from "./loader-records.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";

it("keeps native Commander identity and retained callback ownership through the actual CLI registry", async () => {
  class NativeCommand extends Command {
    #identity = "native";
    identity() {
      return this.#identity;
    }
    override createCommand(name?: string) {
      return new NativeCommand(name);
    }
  }
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "native-cli-registry",
    source: "test",
    origin: "global",
    enabled: true,
    configSchema: true,
  });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {} });
  const instance = getPluginInstance(record);
  if (!instance) {
    throw new Error("Expected managed plugin instance");
  }
  const runtime = createPluginRuntimeStore<{ id: string }>({
    pluginId: record.id,
    errorMessage: "Native CLI registry runtime unavailable",
  });
  instance.run(() => runtime.setRuntime({ id: record.id }));
  const host = new NativeCommand();
  const prepared = new NativeCommand("prepared");
  const value = () => "function-valued data";
  const events: string[] = [];
  prepared.addOption(new Option("--value <text>").argParser(() => value));
  prepared.action(async function (options, command) {
    expect(this).toBe(prepared);
    expect(command).toBe(prepared);
    expect(prepared.identity()).toBe("native");
    expect(options.value).toBe(value);
    await Promise.resolve();
    events.push(runtime.getRuntime().id);
  });

  try {
    api.registerCli(
      async ({ program }) => {
        expect(program === host).toBe(true);
        await Promise.resolve();
        expect(program.addCommand(prepared)).toBe(host);
        expect(program.commands[0]).toBe(prepared);
        const direct = program.command("direct");
        expect(direct).toBe(program.commands[1]);
        direct.action(() => {
          events.push(`direct:${runtime.getRuntime().id}`);
        });
      },
      { commands: ["prepared", "direct"] },
    );
    const registration = builder.registry.cliRegistrars[0];
    if (!registration) {
      throw new Error("Expected actual operation-registrar entry");
    }
    await registration.register({ program: host, parentPath: [], config: {}, logger: api.logger });
    expect(runtime.tryGetRuntime()).toBeNull();
    await host.parseAsync(["prepared", "--value", "input"], { from: "user" });
    await host.parseAsync(["direct"], { from: "user" });
    expect(events).toEqual([record.id, `direct:${record.id}`]);
    expect(runtime.tryGetRuntime()).toBeNull();
    await instance.dispose();
    await expect(host.parseAsync(["direct"], { from: "user" })).rejects.toThrow(
      /reloaded or disabled/i,
    );
  } finally {
    await instance.dispose();
    runtime.clearRuntime();
  }
});
