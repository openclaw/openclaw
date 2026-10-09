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

  it.each([false, true])(
    "drains an admitted async action and rejects a new parse while retiring (prepared: %s)",
    async (prepared) => {
      const owner = fixture();
      const started = createDeferredCore();
      const finish = createDeferredCore();
      const first = new Command();
      const second = new Command();
      const register: OpenClawPluginCliRegistrar = ({ program }) => {
        const command = prepared ? new Command("run") : program.command("run");
        command.action(async () => {
          started.resolve();
          await finish.promise;
          expect(current()).toBe("alpha");
        });
        if (prepared) {
          program.addCommand(command);
        }
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
    },
  );

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

  it("adopts preconfigured command callbacks when the registrar adds their native tree", async () => {
    const owner = fixture();
    const host = new Command();
    const events: string[] = [];
    let child!: Command;
    const option = new Option("--account <id>").argParser((value) => `${current()}:${value}`);
    const argument = new Argument("<value>").argParser((value) => `${current()}:${value}`);
    await owner.register(host, ({ program }) => {
      child = new Command("prepared");
      child.addOption(option).addArgument(argument);
      child.hook("preAction", (command) => {
        expect(command).toBe(child);
        events.push(`pre:${current()}`);
      });
      child.action(async function (value, options, command) {
        expect(this).toBe(child);
        expect(command).toBe(child);
        expect(value).toBe("alpha:input");
        expect(options.account).toBe("alpha:target");
        await Promise.resolve();
        events.push(`action:${current()}`);
      });
      child.hook("postAction", () => {
        events.push(`post:${current()}`);
      });
      expect(program.addCommand(child)).toBe(program);
    });
    expect(host.commands[0]).toBe(child);
    expect(child.options[0]).toBe(option);
    expect(child.registeredArguments[0]).toBe(argument);
    expect(runtime.tryGetRuntime()).toBeNull();
    await host.parseAsync(["prepared", "input", "--account", "target"], { from: "user" });
    expect(events).toEqual(["pre:alpha", "action:alpha", "post:alpha"]);
    expect(runtime.tryGetRuntime()).toBeNull();
    await owner.instance.dispose();
    await expect(
      host.parseAsync(["prepared", "input", "--account", "target"], { from: "user" }),
    ).rejects.toThrow("reloaded or disabled");
  });

  it("adopts prepared descendant help and listeners without replaying listener meta-events", async () => {
    const owner = fixture();
    const host = new Command();
    const branch = new Command("prepared");
    const leaf = new Command("leaf");
    if (!(leaf instanceof EventEmitter)) {
      throw new Error("Expected native EventEmitter");
    }
    const output: string[] = [];
    const seen: string[] = [];
    const listener = function (this: Command) {
      expect(this).toBe(leaf);
      seen.push(current());
    };
    const newListener = vi.fn();
    const removedListener = vi.fn();
    leaf.on("newListener", newListener).on("removeListener", removedListener);
    leaf.on("custom", listener).once("custom", listener);
    leaf.configureHelp({ commandDescription: () => current() });
    leaf.configureOutput({ writeOut: (text) => output.push(`${current()}:${text}`) });
    leaf.addHelpText("after", () => `help:${current()}`);
    leaf.action(() => {
      seen.push(`action:${current()}`);
    });
    branch.addCommand(leaf);
    const addedBefore = newListener.mock.calls.length;
    const removedBefore = removedListener.mock.calls.length;
    await owner.register(host, ({ program }) => {
      program.addCommand(branch);
    });
    expect(newListener.mock.calls).toHaveLength(addedBefore);
    expect(removedListener.mock.calls).toHaveLength(removedBefore);
    expect(host.commands[0]).toBe(branch);
    expect(branch.commands[0]).toBe(leaf);
    expect(leaf.listeners("custom")).toEqual([listener, listener]);
    leaf.emit("custom");
    leaf.off("custom", listener);
    leaf.emit("custom");
    expect(seen).toEqual(["alpha", "alpha"]);
    expect(leaf.listenerCount("custom")).toBe(0);
    leaf.outputHelp();
    expect(output.join("")).toContain("help:alpha");
    await host.parseAsync(["prepared", "leaf"], { from: "user" });
    expect(seen).toEqual(["alpha", "alpha", "action:alpha"]);
    await owner.instance.dispose();
    expect(() => leaf.outputHelp()).toThrow("reloaded or disabled");
    await expect(host.parseAsync(["prepared", "leaf"], { from: "user" })).rejects.toThrow(
      "reloaded or disabled",
    );
  });

  it("preserves native listener-array descriptors without invoking metadata accessors", async () => {
    const owner = fixture();
    const child = new Command("prepared");
    if (!(child instanceof EventEmitter)) {
      throw new Error("Expected native EventEmitter");
    }
    const seen: string[] = [];
    child.on("custom", () => seen.push(`on:${current()}`));
    child.once("custom", () => seen.push(`once:${current()}`));
    const events: unknown = Reflect.get(child, "_events");
    if (!events || typeof events !== "object") {
      throw new Error("Expected the real EventEmitter event table");
    }
    const stored: unknown = Reflect.get(events, "custom");
    if (!Array.isArray(stored)) {
      throw new Error("Expected the real EventEmitter listener array");
    }
    const metadata = Symbol("native-array-metadata");
    const marker = {};
    const readMetadata = vi.fn(() => marker);
    const prototype = Object.create(Object.getPrototypeOf(stored));
    Object.setPrototypeOf(stored, prototype);
    Object.defineProperty(stored, metadata, { get: readMetadata, configurable: true });
    Object.defineProperty(stored, "__proto__", { value: marker, configurable: true });
    const length = Object.getOwnPropertyDescriptor(stored, "length");

    await owner.register(new Command(), ({ program }) => {
      program.addCommand(child);
    });
    const reboundEvents: unknown = Reflect.get(child, "_events");
    if (!reboundEvents || typeof reboundEvents !== "object") {
      throw new Error("Expected the adopted EventEmitter event table");
    }
    const rebound: unknown = Reflect.get(reboundEvents, "custom");
    if (!Array.isArray(rebound)) {
      throw new Error("Expected an adopted native listener array");
    }
    expect(rebound).not.toBe(stored);
    expect(Object.getPrototypeOf(rebound)).toBe(prototype);
    expect(Reflect.ownKeys(rebound)).toEqual(Reflect.ownKeys(stored));
    expect(Object.getOwnPropertyDescriptor(rebound, "length")).toEqual(length);
    for (const key of [metadata, "__proto__"]) {
      expect(Object.getOwnPropertyDescriptor(rebound, key)).toEqual(
        Object.getOwnPropertyDescriptor(stored, key),
      );
    }
    expect(readMetadata).not.toHaveBeenCalled();
    child.emit("custom");
    child.emit("custom");
    expect(seen).toEqual(["on:alpha", "once:alpha", "on:alpha"]);
    expect(readMetadata).not.toHaveBeenCalled();
  });

  it("removes the latest matching prepared on/once registration before emission", async () => {
    const owner = fixture();
    const host = new Command();
    const child = new Command("prepared");
    if (!(child instanceof EventEmitter)) {
      throw new Error("Expected native EventEmitter");
    }
    const seen: string[] = [];
    const listener = () => seen.push(current());
    child.on("custom", listener).once("custom", listener);
    await owner.register(host, ({ program }) => {
      program.addCommand(child);
    });
    child.off("custom", listener);
    child.emit("custom");
    child.emit("custom");
    expect(seen).toEqual(["alpha", "alpha"]);
    expect(child.listenerCount("custom")).toBe(1);
    child.off("custom", listener);
    await owner.instance.dispose();
    expect(child.emit("custom")).toBe(false);
  });

  it.each(["add", "remove"] as const)(
    "preserves native in-flight listener snapshots when prepared listeners %s during emission",
    async (mutation) => {
      const run = async (managed: boolean) => {
        const command = new Command("prepared");
        if (!(command instanceof EventEmitter)) {
          throw new Error("Expected native EventEmitter");
        }
        const seen: string[] = [];
        let changed = false;
        const second = () => seen.push("second");
        const added = () => seen.push("added");
        command.on("custom", () => {
          if (managed) {
            expect(current()).toBe("alpha");
          }
          seen.push("first");
          if (!changed) {
            changed = true;
            if (mutation === "add") {
              command.on("custom", added);
            } else {
              command.off("custom", second);
            }
          }
        });
        command.on("custom", second);
        if (managed) {
          const owner = fixture();
          await owner.register(new Command(), ({ program }) => {
            program.addCommand(command);
          });
        }
        command.emit("custom");
        const firstEmission = [...seen];
        command.emit("custom");
        return { firstEmission, seen };
      };
      const native = await run(false);
      expect(native.firstEmission).toEqual(["first", "second"]);
      expect(await run(true)).toEqual(native);
    },
  );

  it("keeps callbacks owned when native addCommand attaches and then throws", async () => {
    const owner = fixture();
    const host = new Command();
    const seen: string[] = [];
    let child!: Command;
    await owner.register(host, ({ program }) => {
      child = new Command("partial").passThroughOptions().action(() => {
        seen.push(current());
      });
      expect(() => program.addCommand(child)).toThrow("enablePositionalOptions");
    });
    expect(host.commands).toContain(child);
    expect(child.parent).toBe(host);
    await child.parseAsync([], { from: "user" });
    expect(seen).toEqual(["alpha"]);
    await owner.instance.dispose();
    await expect(child.parseAsync([], { from: "user" })).rejects.toThrow("reloaded or disabled");
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
