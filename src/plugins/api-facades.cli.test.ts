import { EventEmitter } from "node:events";
import { Argument, Command, Option } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExpectedCliError, isExpectedCliError } from "../cli/failure-output.js";
import { createPluginRuntimeStore, type PluginRuntime } from "../plugin-sdk/runtime-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { buildPluginApi } from "./api-builder.js";
import { instrumentPluginInstanceApi } from "./api-facades.js";
import { PluginInstance } from "./plugin-instance.js";
import type { OpenClawPluginCliRegistrar } from "./plugin-registration.types.js";

const runtime = createPluginRuntimeStore<{ id: string }>({
  pluginId: "cli-binding-test",
  errorMessage: "CLI runtime missing",
});
const instances: PluginInstance[] = [];
function fixture(id = "alpha") {
  const instance = new PluginInstance(id);
  instances.push(instance);
  const registrations: OpenClawPluginCliRegistrar[] = [];
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
      handlers: { registerCli: (registrar) => void registrations.push(registrar) },
    }),
    instance,
  );
  instance.run(() => runtime.setRuntime({ id }));
  return {
    instance,
    async register(program: Command, registrar: OpenClawPluginCliRegistrar) {
      api.registerCli(registrar, { commands: [id] });
      await registrations.at(-1)!({ program, parentPath: [], config: {}, logger: api.logger });
    },
  };
}
async function register(registrar: OpenClawPluginCliRegistrar, host = new Command()) {
  const owner = fixture();
  await owner.register(host, registrar);
  return { host, instance: owner.instance };
}
const current = () => runtime.getRuntime().id;
const parse = (command: Command, ...args: string[]) => command.parseAsync(args, { from: "user" });
const scopedValue = (value: string) => `${current()}:${value}`;
const retired = (result: Promise<Command>) =>
  expect(result).rejects.toThrow("reloaded or disabled");
const adopt = (command: Command) => register(({ program }) => void program.addCommand(command));
const record = (events: string[], stage: string) => () => void events.push(`${stage}:${current()}`);
function identities(expected: Command, ...values: unknown[]) {
  for (const value of values) {
    expect(value).toBe(expected);
  }
}
function parsedCallbacks(command: Command, events: string[], check?: (self: Command) => void) {
  command.hook("preAction", (parent, action) => {
    identities(command, parent, action);
    const recordPre = record(events, "pre");
    return check ? Promise.resolve().then(recordPre) : recordPre();
  });
  expect(
    command.action(async function (value, options, action) {
      identities(command, this, action);
      check?.(this);
      expect([value, options.account]).toEqual(["alpha:input", "alpha:target"]);
      await Promise.resolve();
      events.push(`action:${current()}`);
    }),
  ).toBe(command);
  command.hook("postAction", record(events, "post"));
}
function emitter<T extends Command>(command: T): T & EventEmitter {
  if (!(command instanceof EventEmitter)) {
    throw new Error("Expected native EventEmitter");
  }
  return command;
}
function listenerArray(command: Command) {
  const events: unknown = Reflect.get(command, "_events");
  if (!events || typeof events !== "object") {
    throw new Error("Expected the real EventEmitter event table");
  }
  const listeners: unknown = Reflect.get(events, "custom");
  if (!Array.isArray(listeners)) {
    throw new Error("Expected the real EventEmitter listener array");
  }
  return listeners;
}
afterEach(async () => {
  for (const instance of instances.splice(0)) {
    await instance.dispose();
  }
  runtime.clearRuntime();
});

describe("managed CLI callbacks", () => {
  it.each(["async", "sync", "commander", "hook", "prepared action", "prepared hook"])(
    "reports failures from a plugin %s through the expected-error boundary",
    async (kind) => {
      const error = new Error("--limit must be a positive integer");
      if (kind === "commander") {
        Object.assign(error, {
          name: "InvalidArgumentError",
          code: "commander.invalidArgument",
          exitCode: 1,
        });
      }
      const fail = () => {
        throw error;
      };
      const { host } = await register(({ program }) => {
        const prepared = kind.startsWith("prepared");
        const command = prepared ? new Command("fail") : program.command("fail");
        if (kind.endsWith("hook")) {
          command.hook("preAction", fail).action(() => {});
        } else {
          command.action(kind === "async" ? async () => fail() : fail);
        }
        if (prepared) {
          program.addCommand(new Command("parent").addCommand(command));
        }
      });

      const args = kind.startsWith("prepared") ? ["parent", "fail"] : ["fail"];
      if (kind === "sync") {
        expect(() => host.parse(args, { from: "user" })).toThrow(ExpectedCliError);
      }
      await expect(parse(host, ...args)).rejects.toSatisfy(
        (failure: unknown) => isExpectedCliError(failure) && failure.message === error.message,
      );
    },
  );

  it("preserves Commander's already-reported action exit", async () => {
    const writeErr = vi.fn();
    let reported: unknown;
    const { host } = await register(({ program }) => {
      program
        .command("fail")
        .configureOutput({ writeErr })
        .exitOverride((error) => {
          reported = error;
          throw error;
        })
        .action(function () {
          this.error("already reported");
        });
    });

    await expect(parse(host, "fail")).rejects.toSatisfy(
      (error: unknown) => error === reported && !(error instanceof ExpectedCliError),
    );
    expect(reported).toMatchObject({ name: "CommanderError", exitCode: 1 });
    expect(writeErr).toHaveBeenCalledWith("already reported\n");
  });

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
    const events: string[] = [];
    let leaf: Command;
    const { instance } = await register(async ({ program }) => {
      expect(program).toBe(host);
      await Promise.resolve();
      const root = program.command("matrix");
      expect(root).toBe(program.commands[0]);
      root.hook("preSubcommand", async (parent, command) => {
        identities(root, parent);
        identities(leaf, command);
        events.push(`sub:${current()}`);
        await Promise.resolve();
        expect(current()).toBe("alpha");
      });
      leaf = root.command("setup");
      expect(leaf.option("--account <id>", "account", scopedValue)).toBe(leaf);
      expect(leaf.argument("<value>", "value", scopedValue)).toBe(leaf);
      parsedCallbacks(leaf, events, (self) => {
        expect(self).toBeInstanceOf(NativeCommand);
        if (!(self instanceof NativeCommand)) {
          throw new Error("Expected native command subclass");
        }
        expect(self.marker()).toBe("native");
      });
    }, host);
    expect(events).toEqual([]);
    expect(runtime.tryGetRuntime()).toBeNull();
    await parse(host, "matrix", "setup", "input", "--account", "target");
    expect(events).toEqual(["sub:alpha", "pre:alpha", "action:alpha", "post:alpha"]);
    expect(runtime.tryGetRuntime()).toBeNull();
    await instance.dispose();
    await retired(parse(host, "matrix", "setup", "input", "--account", "target"));
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
    await alpha.register(host, ({ program }) => void program.command("alpha").action(action));
    await beta.register(host, ({ program }) => void program.command("beta").action(action));
    await parse(host, "alpha");
    await parse(host, "beta");
    await alpha.instance.dispose();
    await retired(parse(host, "alpha"));
    await parse(host, "beta");
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
      const registrar: OpenClawPluginCliRegistrar = ({ program }) => {
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
      await owner.register(first, registrar);
      await owner.register(second, registrar);
      const running = parse(first, "run");
      await started.promise;
      let disposed = false;
      const disposal = owner.instance.dispose().then(() => {
        disposed = true;
      });
      try {
        const next = parse(second, "run");
        const rejected = retired(next);
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
    const host = emitter(new Command());
    const seen: string[] = [];
    const listener = function (this: Command) {
      expect(this).toBe(host);
      seen.push(current());
    };
    const { instance } = await register(({ program: command }) => {
      const program = emitter(command);
      expect(program.on("custom", listener)).toBe(program);
      expect(program.listeners("custom")).toEqual([listener]);
      expect(program.off("custom", listener)).toBe(program);
      expect(program.listenerCount("custom")).toBe(0);
      program.once("custom", listener);
      program.prependOnceListener("custom", listener);
      program.option("--flag").on("option:flag", listener);
    }, host);
    expect(host.listeners("custom")).toEqual([listener, listener]);
    host.emit("custom");
    host.emit("custom");
    expect(host.listenerCount("custom")).toBe(0);
    await parse(host, "--flag");
    expect(seen).toEqual(["alpha", "alpha", "alpha"]);
    await instance.dispose();
    expect(() => host.emit("option:flag")).toThrow("reloaded or disabled");
  });

  it("binds callbacks installed by an async lazy subcommand hook", async () => {
    const installed = vi.fn();
    const action = vi.fn((options) => {
      expect(current()).toBe("alpha");
      expect(options.account).toBe("alpha:target");
    });
    const { host } = await register(({ program }) => {
      const root = program.command("lazy");
      const leaf = root.command("run");
      root.hook("preSubcommand", async () => {
        await Promise.resolve();
        expect(current()).toBe("alpha");
        leaf.option("--account <id>", "account", scopedValue).action(action);
        installed();
      });
    });
    expect(installed).not.toHaveBeenCalled();
    await parse(host, "lazy", "run", "--account", "target");
    expect(installed).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledOnce();
  });

  it("adopts preconfigured command callbacks when the registrar adds their native tree", async () => {
    const events: string[] = [];
    let child!: Command;
    const option = new Option("--account <id>").argParser(scopedValue);
    const argument = new Argument("<value>").argParser(scopedValue);
    const { host, instance } = await register(({ program }) => {
      child = new Command("prepared");
      child.addOption(option).addArgument(argument);
      parsedCallbacks(child, events);
      expect(program.addCommand(child)).toBe(program);
    });
    expect(host.commands[0]).toBe(child);
    expect(child.options[0]).toBe(option);
    expect(child.registeredArguments[0]).toBe(argument);
    expect(runtime.tryGetRuntime()).toBeNull();
    await parse(host, "prepared", "input", "--account", "target");
    expect(events).toEqual(["pre:alpha", "action:alpha", "post:alpha"]);
    expect(runtime.tryGetRuntime()).toBeNull();
    await instance.dispose();
    expect(() => option.parseArg!("stale", undefined)).toThrow("reloaded or disabled");
    expect(() => argument.parseArg!("stale", undefined)).toThrow("reloaded or disabled");
    await retired(parse(host, "prepared", "input", "--account", "target"));
  });

  it("adopts prepared descendant help and listeners without replaying listener meta-events", async () => {
    const branch = new Command("prepared");
    const leaf = emitter(new Command("leaf"));
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
    leaf.action(record(seen, "action"));
    branch.addCommand(leaf);
    const addedBefore = newListener.mock.calls.length;
    const removedBefore = removedListener.mock.calls.length;
    const { host, instance } = await adopt(branch);
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
    await parse(host, "prepared", "leaf");
    expect(seen).toEqual(["alpha", "alpha", "action:alpha"]);
    await instance.dispose();
    expect(() => leaf.outputHelp()).toThrow("reloaded or disabled");
    await retired(parse(host, "prepared", "leaf"));
  });

  it("preserves native listener-array descriptors without invoking metadata accessors", async () => {
    const child = emitter(new Command("prepared"));
    const seen: string[] = [];
    child.on("custom", () => seen.push(`on:${current()}`));
    child.once("custom", () => seen.push(`once:${current()}`));
    const stored = listenerArray(child);
    const metadata = Symbol("native-array-metadata");
    const marker = {};
    const readMetadata = vi.fn(() => marker);
    const prototype = Object.create(Object.getPrototypeOf(stored));
    Object.setPrototypeOf(stored, prototype);
    Object.defineProperty(stored, metadata, { get: readMetadata, configurable: true });
    Object.defineProperty(stored, "__proto__", { value: marker, configurable: true });
    const length = Object.getOwnPropertyDescriptor(stored, "length");

    await adopt(child);
    const rebound = listenerArray(child);
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
    const child = emitter(new Command("prepared"));
    const seen: string[] = [];
    const listener = () => seen.push(current());
    child.on("custom", listener).once("custom", listener);
    const { instance } = await adopt(child);
    child.off("custom", listener);
    child.emit("custom");
    child.emit("custom");
    expect(seen).toEqual(["alpha", "alpha"]);
    expect(child.listenerCount("custom")).toBe(1);
    child.off("custom", listener);
    await instance.dispose();
    expect(child.emit("custom")).toBe(false);
  });

  it.each(["add", "remove"] as const)(
    "preserves native in-flight listener snapshots when prepared listeners %s during emission",
    async (mutation) => {
      const command = emitter(new Command("prepared"));
      const seen: string[] = [];
      let changed = false;
      const second = () => seen.push("second");
      const added = () => seen.push("added");
      command.on("custom", () => {
        expect(current()).toBe("alpha");
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
      await adopt(command);
      command.emit("custom");
      expect(seen).toEqual(["first", "second"]);
      command.emit("custom");
      expect(seen).toEqual(
        mutation === "add"
          ? ["first", "second", "first", "second", "added"]
          : ["first", "second", "first"],
      );
    },
  );

  it("keeps callbacks owned when native addCommand attaches and then throws", async () => {
    const seen: string[] = [];
    let child!: Command;
    const { host, instance } = await register(({ program }) => {
      child = new Command("partial").passThroughOptions().action(() => {
        seen.push(current());
      });
      expect(() => program.addCommand(child)).toThrow("enablePositionalOptions");
    });
    expect(host.commands).toContain(child);
    expect(child.parent).toBe(host);
    await parse(child);
    expect(seen).toEqual(["alpha"]);
    await instance.dispose();
    await retired(parse(child));
  });

  it("does not adopt preexisting host callbacks or change a caller-owned command's identity", async () => {
    const host = new Command();
    const foreign = new Command("host");
    const error = new Error("host failure");
    const hostAction = vi.fn(function (this: Command, _options, command) {
      identities(foreign, this, command);
      expect(runtime.tryGetRuntime()).toBeNull();
      throw error;
    });
    foreign.action(hostAction);
    host.addCommand(foreign);
    const { instance } = await register(({ program }) => {
      program.command("plugin").action(() => void current());
    }, host);
    expect(host.commands[0]).toBe(foreign);
    await instance.dispose();
    await expect(parse(host, "host")).rejects.toBe(error);
    expect(hostAction).toHaveBeenCalledOnce();
  });
});
