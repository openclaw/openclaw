import { EventEmitter } from "node:events";
import { Argument, Command, Option } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntimeStore, type PluginRuntime } from "../plugin-sdk/runtime-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { buildPluginApi } from "./api-builder.js";
import { instrumentPluginInstanceApi } from "./api-facades.js";
import { PluginInstance } from "./plugin-instance.js";
import type {
  OpenClawPluginCliRegistrar,
  OpenClawPluginCliRegistrationOptions,
} from "./plugin-registration.types.js";

const runtime = createPluginRuntimeStore<{ id: string }>({
  pluginId: "cli-binding-test",
  errorMessage: "CLI runtime missing",
});
const instances: PluginInstance[] = [];
function fixture(id = "alpha") {
  const instance = new PluginInstance(id);
  instances.push(instance);
  const registrations: {
    registrar: OpenClawPluginCliRegistrar;
    options?: OpenClawPluginCliRegistrationOptions;
  }[] = [];
  const api = instrumentPluginInstanceApi(
    buildPluginApi({
      id,
      name: id,
      source: "test",
      registrationMode: "discovery",
      config: {},
      runtime: {} as PluginRuntime,
      resolvePath: (value) => value,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      handlers: {
        registerCli: (registrar, options) => {
          registrations.push({ registrar, options });
        },
      },
    }),
    instance,
  );
  instance.run(() => runtime.setRuntime({ id }));
  return {
    api,
    instance,
    registrations,
    async register(program: Command, registrar: OpenClawPluginCliRegistrar) {
      api.registerCli(registrar, { commands: [id] });
      await registrations
        .at(-1)!
        .registrar({ program, parentPath: [], config: {}, logger: api.logger });
    },
  };
}
const current = () => runtime.getRuntime().id;
afterEach(async () => {
  for (const instance of instances.splice(0)) {
    await instance.dispose();
  }
  runtime.clearRuntime();
  vi.unstubAllEnvs();
});

describe("managed CLI callbacks", () => {
  it("keeps native fluent/subclass identity and scopes delayed action, hook and parser callbacks", async () => {
    class NativeCommand extends Command {
      #marker = "native";
      marker() {
        return this.#marker;
      }
      override createCommand(name?: string) {
        return new NativeCommand(name);
      }
    }
    const host = new NativeCommand();
    const owner = fixture();
    const events: string[] = [];
    let leaf: Command;
    await owner.register(host, async ({ program }) => {
      expect(program).toBe(host);
      await Promise.resolve();
      const root = program.command("matrix");
      expect(root).toBe(program.commands[0]);
      root.hook("preSubcommand", async (parent, command) => {
        expect(parent).toBe(root);
        expect(command).toBe(leaf);
        events.push(`sub:${current()}`);
        await Promise.resolve();
        expect(current()).toBe("alpha");
      });
      leaf = root.command("setup");
      expect(leaf.option("--account <id>", "account", (value) => `${current()}:${value}`)).toBe(
        leaf,
      );
      expect(leaf.argument("<value>", "value", (value) => `${current()}:${value}`)).toBe(leaf);
      leaf.hook("preAction", async (command, action) => {
        expect(command).toBe(leaf);
        expect(action).toBe(leaf);
        await Promise.resolve();
        events.push(`pre:${current()}`);
      });
      expect(
        leaf.action(async function (value, options, command) {
          expect(this).toBe(leaf);
          expect(command).toBe(leaf);
          expect(this).toBeInstanceOf(NativeCommand);
          if (!(this instanceof NativeCommand)) {
            throw new Error("Expected native command subclass");
          }
          expect(this.marker()).toBe("native");
          expect(value).toBe("alpha:input");
          expect(options.account).toBe("alpha:target");
          await Promise.resolve();
          events.push(`action:${current()}`);
        }),
      ).toBe(leaf);
      leaf.hook("postAction", () => {
        events.push(`post:${current()}`);
      });
    });
    expect(events).toEqual([]);
    expect(runtime.tryGetRuntime()).toBeNull();
    await host.parseAsync(["matrix", "setup", "input", "--account", "target"], { from: "user" });
    expect(events).toEqual(["sub:alpha", "pre:alpha", "action:alpha", "post:alpha"]);
    expect(runtime.tryGetRuntime()).toBeNull();
    await owner.instance.dispose();
    await expect(
      host.parseAsync(["matrix", "setup", "input", "--account", "target"], { from: "user" }),
    ).rejects.toThrow("reloaded or disabled");
  });

  it("binds prepared and later Option/Argument parsers without changing their native identity", async () => {
    const owner = fixture();
    const host = new Command();
    vi.stubEnv("CLI_BINDING_ACCOUNT", "from-env");
    const option = new Option("--account <id>")
      .env("CLI_BINDING_ACCOUNT")
      .argParser((value) => `${current()}:${value}`);
    const argument = new Argument("<name>").argParser((value) => `${current()}:${value}`);
    let command: Command;
    await owner.register(host, ({ program }) => {
      command = program.createCommand("prepared");
      expect(program.addCommand(command)).toBe(program);
      expect(command.addOption(option)).toBe(command);
      expect(command.addArgument(argument)).toBe(command);
      expect(command.options[0]).toBe(option);
      expect(command.registeredArguments[0]).toBe(argument);
      command.action((name, options, action) => {
        expect(action).toBe(command);
        expect(name).toBe("alpha:name");
        expect(options.account).toBe("alpha:from-env");
      });
    });
    await host.parseAsync(["prepared", "name"], { from: "user" });
    await owner.instance.dispose();
    expect(() => option.parseArg!("stale", undefined)).toThrow("reloaded or disabled");
    expect(() => argument.parseArg!("stale", undefined)).toThrow("reloaded or disabled");
  });

  it("keeps sibling instances and async continuations on their own runtime when sharing a native root", async () => {
    const host = new Command();
    const alpha = fixture("alpha");
    const beta = fixture("beta");
    const observations: string[] = [];
    const action = async function (this: Command) {
      const before = current();
      await Promise.resolve();
      observations.push(`${this.name()}:${before}:${current()}`);
    };
    await alpha.register(host, ({ program }) => {
      program.command("alpha").action(action);
    });
    await beta.register(host, ({ program }) => {
      program.command("beta").action(action);
    });
    await host.parseAsync(["alpha"], { from: "user" });
    await host.parseAsync(["beta"], { from: "user" });
    await alpha.instance.dispose();
    await expect(host.parseAsync(["alpha"], { from: "user" })).rejects.toThrow(
      "reloaded or disabled",
    );
    await host.parseAsync(["beta"], { from: "user" });
    expect(observations).toEqual(["alpha:alpha:alpha", "beta:beta:beta", "beta:beta:beta"]);
    expect(runtime.tryGetRuntime()).toBeNull();
  });

  it("drains an admitted async action and rejects a new parse while retiring", async () => {
    const owner = fixture();
    const started = createDeferredCore();
    const finish = createDeferredCore();
    const first = new Command();
    const second = new Command();
    const register: OpenClawPluginCliRegistrar = ({ program }) => {
      program.command("run").action(async () => {
        started.resolve();
        await finish.promise;
        expect(current()).toBe("alpha");
      });
    };
    await owner.register(first, register);
    await owner.register(second, register);
    const running = first.parseAsync(["run"], { from: "user" });
    await started.promise;
    let disposed = false;
    const disposal = owner.instance.dispose().then(() => {
      disposed = true;
    });
    try {
      const next = second.parseAsync(["run"], { from: "user" });
      const rejected = expect(next).rejects.toThrow("reloaded or disabled");
      expect(disposed).toBe(false);
      finish.resolve();
      await rejected;
    } finally {
      finish.resolve();
      await running;
      await disposal;
    }
    expect(disposed).toBe(true);
  });

  it("preserves EventEmitter once/removal/listener identity while binding delayed option events", async () => {
    const owner = fixture();
    const host = new Command();
    const seen: string[] = [];
    if (!(host instanceof EventEmitter)) {
      throw new Error("Expected native EventEmitter");
    }
    const listener = function (this: Command) {
      expect(this).toBe(host);
      seen.push(current());
    };
    await owner.register(host, ({ program }) => {
      if (!(program instanceof EventEmitter)) {
        throw new Error("Expected native EventEmitter");
      }
      expect(program.on("custom", listener)).toBe(program);
      expect(program.listeners("custom")).toEqual([listener]);
      expect(program.off("custom", listener)).toBe(program);
      expect(program.listenerCount("custom")).toBe(0);
      program.once("custom", listener);
      program.prependOnceListener("custom", listener);
      program.option("--flag").on("option:flag", listener);
    });
    expect(host.listeners("custom")).toEqual([listener, listener]);
    host.emit("custom");
    host.emit("custom");
    expect(host.listenerCount("custom")).toBe(0);
    await host.parseAsync(["--flag"], { from: "user" });
    expect(seen).toEqual(["alpha", "alpha", "alpha"]);
    await owner.instance.dispose();
    expect(() => host.emit("option:flag")).toThrow("reloaded or disabled");
  });

  it("keeps help lazy and scopes configured help/output callbacks with native command arguments", async () => {
    const owner = fixture();
    const host = new Command("help-test");
    const output: string[] = [];
    const description = vi.fn((command: Command) => {
      expect(command).toBe(host);
      return current();
    });
    await owner.register(host, ({ program }) => {
      expect(program.configureHelp({ commandDescription: description })).toBe(program);
      expect(
        program.configureOutput({
          writeOut: (text) => {
            expect(current()).toBe("alpha");
            output.push(text);
          },
        }),
      ).toBe(program);
      expect(
        program.addHelpText("after", ({ command }) => {
          expect(command).toBe(host);
          return `extra:${current()}`;
        }),
      ).toBe(program);
    });
    expect(description).not.toHaveBeenCalled();
    expect(output).toEqual([]);
    host.outputHelp();
    expect(output.join("")).toContain("extra:alpha");
    expect(description).toHaveBeenCalled();
    await owner.instance.dispose();
    expect(() => host.outputHelp()).toThrow("reloaded or disabled");
  });

  it("binds callbacks installed by an async lazy subcommand hook", async () => {
    const owner = fixture();
    const host = new Command();
    const installed = vi.fn();
    const action = vi.fn((options) => {
      expect(current()).toBe("alpha");
      expect(options.account).toBe("alpha:target");
    });
    await owner.register(host, ({ program }) => {
      const root = program.command("lazy");
      const leaf = root.command("run");
      root.hook("preSubcommand", async () => {
        await Promise.resolve();
        expect(current()).toBe("alpha");
        leaf.option("--account <id>", "account", (value) => `${current()}:${value}`).action(action);
        installed();
      });
    });
    expect(installed).not.toHaveBeenCalled();
    await host.parseAsync(["lazy", "run", "--account", "target"], { from: "user" });
    expect(installed).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledOnce();
  });

  it("scopes exit overrides without replacing native Commander errors", async () => {
    const owner = fixture();
    const host = new Command();
    const exit = vi.fn((error: Error) => {
      expect(current()).toBe("alpha");
      throw error;
    });
    await owner.register(host, ({ program }) => {
      program.configureOutput({ writeErr() {} }).exitOverride(exit);
    });
    expect(() => host.error("synthetic failure", { code: "cli.fixture", exitCode: 9 })).toThrow(
      "synthetic failure",
    );
    expect(exit).toHaveBeenCalledOnce();
    expect(exit.mock.calls[0]?.[0]).toMatchObject({ code: "cli.fixture", exitCode: 9 });
  });

  it("binds the node-feature alias through the same CLI owner", async () => {
    const owner = fixture();
    const program = new Command("nodes");
    const action = vi.fn(() => {
      expect(current()).toBe("alpha");
    });
    owner.api.registerNodeCliFeature(
      ({ program: parent }) => {
        parent.command("camera").action(action);
      },
      { commands: ["camera"] },
    );
    const { registrar, options } = owner.registrations[0]!;
    expect(options?.parentPath).toEqual(["nodes"]);
    await registrar({ program, parentPath: ["nodes"], config: {}, logger: owner.api.logger });
    await program.parseAsync(["camera"], { from: "user" });
    expect(action).toHaveBeenCalledOnce();
  });

  it("preserves function-valued parser defaults and results as native caller data", async () => {
    const owner = fixture();
    const host = new Command();
    const value = () => "data";
    const action = vi.fn((argument, options) => {
      expect(current()).toBe("alpha");
      expect(argument).toBe(value);
      expect(options.transform).toBe(value);
    });
    await owner.register(host, ({ program }) => {
      program
        .command("data")
        .option("--transform <value>", "transform", () => value, value)
        .argument("[value]", "value", () => value, value)
        .action(action);
    });
    await host.parseAsync(["data"], { from: "user" });
    await host.parseAsync(["data", "input", "--transform", "input"], { from: "user" });
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("does not adopt preexisting host callbacks or change a caller-owned command's identity", async () => {
    const host = new Command();
    const foreign = new Command("host");
    const hostAction = vi.fn(function (this: Command, _options, command) {
      expect(this).toBe(foreign);
      expect(command).toBe(foreign);
      expect(runtime.tryGetRuntime()).toBeNull();
    });
    foreign.action(hostAction);
    host.addCommand(foreign);
    const owner = fixture();
    await owner.register(host, ({ program }) => {
      program.command("plugin").action(() => {
        current();
      });
    });
    expect(host.commands[0]).toBe(foreign);
    await owner.instance.dispose();
    await host.parseAsync(["host"], { from: "user" });
    expect(hostAction).toHaveBeenCalledOnce();
  });
});
