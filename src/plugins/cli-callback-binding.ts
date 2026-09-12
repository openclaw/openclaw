import { EventEmitter } from "node:events";
import type { Argument, Command, Option } from "commander";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";

// These mark native objects whose public registration methods have been adapted,
// not runtime owners. Each callback resolves its owner from the existing invocation.
const commands = new WeakSet<Command>();
const parsers = new WeakSet<Option | Argument>();

function bindCallback<T>(value: T): T {
  const instance = pluginInstanceInvocation.getStore()?.instance;
  if (typeof value !== "function" || !instance) {
    return value;
  }
  const bound = function (this: unknown, ...args: unknown[]) {
    return instance.run(() => Reflect.apply(value, this, args));
  };
  // CLI callbacks receive native Commander objects and parser-produced data, not plugin views.
  // SAFETY: The wrapper forwards the same receiver, arguments, and return value.
  return bound as T;
}

function bindConfiguration<T>(value: T): T {
  if (!value || typeof value !== "object") {
    return value;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if ("value" in descriptor) {
      descriptor.value = bindCallback(descriptor.value);
    }
  }
  // Keep configuration prototypes/accessors and data identities; only supplied
  // callbacks become managed handles, not Commander or its callback arguments.
  return Object.create(Object.getPrototypeOf(value), descriptors);
}

function bindParser(parser: Option | Argument): void {
  if (parsers.has(parser)) {
    return;
  }
  parsers.add(parser);
  const argParser = parser.argParser;
  Object.defineProperty(parser, "argParser", {
    configurable: true,
    writable: true,
    value(this: Option | Argument, callback: Parameters<Option["argParser"]>[0]) {
      return Reflect.apply(argParser, this, [bindCallback(callback)]);
    },
  });
  if (parser.parseArg) {
    parser.parseArg = bindCallback(parser.parseArg);
  }
}

function bindPluginCliEvents(program: EventEmitter): void {
  // EventEmitter's once/prependOnceListener use these public listener methods.
  // Preserve listener/removal identity, including once's own removal callback.
  const listenerOrigins = new WeakMap<Function, Function>();
  for (const name of ["on", "addListener", "prependListener"] as const) {
    const method = program[name];
    program[name] = function (event, listener) {
      const managed = bindCallback(listener);
      if (managed === listener) {
        return method.call(this, event, listener);
      }
      const bound = function (this: EventEmitter, ...args: unknown[]) {
        return Reflect.apply(managed, this, args);
      };
      Object.defineProperty(bound, "listener", {
        value: Reflect.get(listener, "listener") ?? listener,
      });
      listenerOrigins.set(bound, listener);
      return method.call(this, event, bound);
    };
  }
  for (const name of ["removeListener", "off"] as const) {
    const method = program[name];
    program[name] = function (event, listener) {
      const registered = this.rawListeners(event).findLast(
        (candidate) => listenerOrigins.get(candidate) === listener,
      );
      return method.call(this, event, registered ?? listener);
    };
  }
}

/**
 * Bind registrations made through the host's native CLI surface. Already prepared
 * Command callbacks remain caller-owned; Commander exposes no public getter for
 * them, and inspecting private storage would also adopt unrelated host callbacks.
 */
export function bindPluginCliProgram(program: Command): void {
  if (commands.has(program)) {
    return;
  }
  commands.add(program);

  // Commander 15 invokes these callbacks later, after the registrar has returned.
  // Retain each supported method's native receiver, overloads and fluent return.
  for (const [name, callbackIndex] of [
    ["action", 0],
    ["hook", 1],
    ["exitOverride", 0],
    ["addHelpText", 1],
  ] as const) {
    const method = program[name];
    Object.defineProperty(program, name, {
      configurable: true,
      writable: true,
      value(this: Command, ...args: unknown[]) {
        return Reflect.apply(
          method,
          this,
          args.map((arg, index) => (index === callbackIndex ? bindCallback(arg) : arg)),
        );
      },
    });
  }
  for (const name of ["configureHelp", "configureOutput"] as const) {
    const method = program[name];
    Object.defineProperty(program, name, {
      configurable: true,
      writable: true,
      value(this: Command, ...args: unknown[]) {
        return Reflect.apply(method, this, args.map(bindConfiguration));
      },
    });
  }

  if (program instanceof EventEmitter) {
    bindPluginCliEvents(program);
  }

  const createCommand = program.createCommand;
  program.createCommand = function (name) {
    const command = createCommand.call(this, name);
    bindPluginCliProgram(command);
    return command;
  };
  const addCommand = program.addCommand;
  program.addCommand = function (command, options) {
    bindPluginCliProgram(command);
    return addCommand.call(this, command, options);
  };
  const createOption = program.createOption;
  program.createOption = function (flags, description) {
    const option = createOption.call(this, flags, description);
    bindParser(option);
    return option;
  };
  for (const name of ["addOption", "addHelpOption"] as const) {
    const method = program[name];
    program[name] = function (option) {
      bindParser(option);
      return method.call(this, option);
    };
  }
  const createArgument = program.createArgument;
  program.createArgument = function (name, description) {
    const argument = createArgument.call(this, name, description);
    bindParser(argument);
    return argument;
  };
  const addArgument = program.addArgument;
  program.addArgument = function (argument) {
    bindParser(argument);
    return addArgument.call(this, argument);
  };
  for (const command of program.commands) {
    bindPluginCliProgram(command);
  }
}
