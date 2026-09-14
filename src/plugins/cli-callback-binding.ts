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

function bindStoredCallbackCollection(
  target: object,
  key: string,
  bind: (value: unknown) => unknown = bindCallback,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  const stored: unknown = descriptor?.value;
  if (!descriptor || !stored || typeof stored !== "object" || Array.isArray(stored)) {
    throw new Error(`Unsupported native CLI callback collection: ${key}`);
  }
  const callbacks = Object.create(Object.getPrototypeOf(stored));
  for (const name of Reflect.ownKeys(stored)) {
    const entry = Object.getOwnPropertyDescriptor(stored, name)!;
    if ("value" in entry) {
      if (Array.isArray(entry.value)) {
        const values: unknown[] = entry.value;
        const descriptors = Object.getOwnPropertyDescriptors(values);
        for (let index = 0; index < values.length; index++) {
          const value = descriptors[index];
          if (value && "value" in value) {
            value.value = bind(value.value);
          }
        }
        // Node retains dispatch/copy-on-write metadata on listener arrays.
        // Keep every own descriptor, including symbols, on a real native array.
        const rebound: unknown[] = [];
        Object.setPrototypeOf(rebound, Object.getPrototypeOf(values));
        entry.value = Object.defineProperties(rebound, descriptors);
      } else {
        entry.value = bind(entry.value);
      }
    }
    Object.defineProperty(callbacks, name, entry);
  }
  Object.defineProperty(target, key, { ...descriptor, value: callbacks });
}

function bindPreparedCommandCallbacks(program: Command): void {
  // Commander 15 exposes setters but no getters for these retained callbacks.
  // Adopt only the named slots of a tree explicitly registered by this plugin,
  // never callbacks already present on the shared host command tree.
  for (const key of ["_actionHandler", "_exitCallback"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(program, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new Error(`Unsupported native Commander callback slot: ${key}`);
    }
    Object.defineProperty(program, key, {
      ...descriptor,
      value: bindCallback(descriptor.value),
    });
  }
  bindStoredCallbackCollection(program, "_lifeCycleHooks");
  program.configureHelp(bindConfiguration(program.configureHelp()));
  program.configureOutput(bindConfiguration(program.configureOutput()));
  for (const parser of [...program.options, ...program.registeredArguments]) {
    bindParser(parser);
  }
}

function bindPluginCliEvents(program: EventEmitter, adoptPrepared: boolean): void {
  // EventEmitter's once/prependOnceListener use these public listener methods.
  // Preserve listener/removal identity, including once's own removal callback.
  const listenerOrigins = new WeakMap<Function, Function>();
  const wrapListener = (listener: Function, managed: Function) => {
    const bound = function (this: EventEmitter, ...args: unknown[]) {
      return Reflect.apply(managed, this, args);
    };
    Object.defineProperty(bound, "listener", {
      value: Reflect.get(listener, "listener") ?? listener,
    });
    listenerOrigins.set(bound, listener);
    return bound;
  };
  if (adoptPrepared) {
    // Preserve Node's native listener order/once wrappers without invoking
    // newListener/removeListener callbacks during ownership adoption.
    bindStoredCallbackCollection(program, "_events", (listener) => {
      if (typeof listener !== "function") {
        return listener;
      }
      const managed = bindCallback(listener);
      return managed === listener ? listener : wrapListener(listener, managed);
    });
  }
  for (const name of ["on", "addListener", "prependListener"] as const) {
    const method = program[name];
    program[name] = function (event, listener) {
      const managed = bindCallback(listener);
      if (managed === listener) {
        return method.call(this, event, listener);
      }
      return method.call(this, event, wrapListener(listener, managed));
    };
  }
  for (const name of ["removeListener", "off"] as const) {
    const method = program[name];
    program[name] = function (event, listener) {
      const registered = this.rawListeners(event).findLast(
        (candidate) =>
          candidate === listener ||
          Reflect.get(candidate, "listener") === listener ||
          listenerOrigins.get(candidate) === listener,
      );
      // Prefer native matching (and its removeListener argument) when possible;
      // only translate the hidden once wrapper's self-removal identity.
      const needsOrigin =
        registered && registered !== listener && Reflect.get(registered, "listener") !== listener;
      return method.call(this, event, needsOrigin ? registered : listener);
    };
  }
}

/**
 * Bind registrations made through the host's native CLI surface. Existing host
 * callbacks remain caller-owned; newly created or explicitly added command trees
 * also transfer their preconfigured callbacks to the active adding instance.
 */
export function bindPluginCliProgram(program: Command, adoptPrepared = false): void {
  if (commands.has(program)) {
    return;
  }
  commands.add(program);
  const adopt = adoptPrepared && pluginInstanceInvocation.getStore()?.instance !== undefined;
  if (adopt) {
    bindPreparedCommandCallbacks(program);
  }

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
    bindPluginCliEvents(program, adopt);
  }

  const createCommand = program.createCommand.bind(program);
  program.createCommand = function (name) {
    const command = createCommand.call(this, name);
    bindPluginCliProgram(command, true);
    return command;
  };
  const addCommand = program.addCommand.bind(program);
  program.addCommand = function (command, options) {
    // Native validation can throw after attaching the child to the host tree.
    // Bind before insertion so a caught registration error cannot leave an escape.
    bindPluginCliProgram(command, true);
    return addCommand.call(this, command, options);
  };
  const createOption = program.createOption.bind(program);
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
  const createArgument = program.createArgument.bind(program);
  program.createArgument = function (name, description) {
    const argument = createArgument.call(this, name, description);
    bindParser(argument);
    return argument;
  };
  const addArgument = program.addArgument.bind(program);
  program.addArgument = function (argument) {
    bindParser(argument);
    return addArgument.call(this, argument);
  };
  for (const command of program.commands) {
    bindPluginCliProgram(command, adopt);
  }
}
