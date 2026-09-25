import { createRequire } from "node:module";
import type { DOMWindow } from "jsdom";
import type { Environment } from "vitest/runtime";

const require = createRequire(import.meta.url);
const adapterInstalled = Symbol.for("openclaw.vitest.jsdom-adapter");
export type JsdomCustomElementDefinition = { name: string };

function bindings() {
  // The package entry initializes the mutually dependent generated interfaces.
  require("jsdom");
  const utils: {
    implForWrapper(wrapper: object): unknown;
    registerWrapper(wrapper: object, impl: unknown, descriptor: object): void;
  } = require("jsdom/lib/generated/idl/utils.js");
  const eventTarget: {
    interfaceDescriptor: object;
    setup(
      this: void,
      wrapper: object,
      globalObject: DOMWindow,
      constructorArgs?: unknown[],
      privateData?: object,
    ): object;
  } = require("jsdom/lib/generated/idl/EventTarget.js");
  const blob: {
    is(value: unknown): value is Blob;
    convert(window: object, value: Blob): { _bytes: Uint8Array<ArrayBuffer> };
  } = require("jsdom/lib/generated/idl/Blob.js");
  const formData: {
    is(value: unknown): value is FormData;
  } = require("jsdom/lib/generated/idl/FormData.js");
  const registry: {
    is(value: unknown): boolean;
    convert(
      window: object,
      value: object,
    ): {
      _customElementDefinitions: JsdomCustomElementDefinition[];
    };
  } = require("jsdom/lib/generated/idl/CustomElementRegistry.js");
  return { utils, eventTarget, blob, formData, registry };
}

export function jsdomCustomElementDefinitions(registry: object) {
  const native = bindings().registry;
  return native.is(registry)
    ? native.convert(globalThis, registry)._customElementDefinitions
    : undefined;
}

function installJsdomWindowAdapter(): void {
  const { utils, eventTarget } = bindings();
  if (Object.hasOwn(eventTarget, adapterInstalled)) {
    return;
  }
  Object.defineProperty(eventTarget, adapterInstalled, { value: true });
  const setup = eventTarget.setup;
  eventTarget.setup = (wrapper, window, ...args) => {
    const result = setup(wrapper, window, ...args);
    // Window initializes its EventTarget with itself as the global object.
    // Register Bun's distinct proxy here so iframe windows receive the same repair.
    if (wrapper === window && utils.implForWrapper(window._globalProxy) === null) {
      utils.registerWrapper(
        window._globalProxy,
        utils.implForWrapper(window),
        eventTarget.interfaceDescriptor,
      );
    }
    return result;
  };
}

export function installJsdomEnvironmentAdapter(environment: Environment): void {
  if (Object.hasOwn(environment, adapterInstalled)) return;
  Object.defineProperty(environment, adapterInstalled, { value: true });
  installJsdomWindowAdapter();
  const NativeBlob = globalThis.Blob;
  const NativeFile = globalThis.File;
  const NativeURL = globalThis.URL;
  const NativeRequest = globalThis.Request;
  const NativeFormData = globalThis.FormData;
  const setup = environment.setup;
  const setupVM = environment.setupVM;

  function installWebApis(target: object, window: DOMWindow) {
    const { blob, formData } = bindings();
    const toNativeBlob = (value: Blob) =>
      new NativeBlob([blob.convert(window, value)._bytes], { type: value.type });
    const toNativeBody = (value: BodyInit): BodyInit => {
      if (blob.is(value)) {
        return toNativeBlob(value);
      }
      if (formData.is(value)) {
        const result = new NativeFormData();
        value.forEach((entry, name) => {
          if (typeof entry === "string") {
            result.append(name, entry);
          } else {
            // The filename overload would rebuild this through jsdom's global File.
            result.append(
              name,
              new NativeFile([blob.convert(window, entry)._bytes], entry.name, {
                type: entry.type,
                lastModified: entry.lastModified,
              }),
            );
          }
        });
        return result;
      }
      return value;
    };
    class URL extends NativeURL {
      static override createObjectURL(
        value: Parameters<typeof NativeURL.createObjectURL>[0],
      ): string {
        return NativeURL.createObjectURL(blob.is(value) ? toNativeBlob(value) : value);
      }
      static override [Symbol.hasInstance](value: unknown): boolean {
        return value instanceof NativeURL;
      }
    }
    class Request extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(input, init?.body == null ? init : { ...init, body: toNativeBody(init.body) });
      }
      static override [Symbol.hasInstance](value: unknown): boolean {
        return value instanceof NativeRequest;
      }
    }
    Object.assign(target, { URL, Request });
  }

  environment.setup = async (global, options) => {
    const originals = new Map(
      ["URL", "Request"].map((key) => [key, Object.getOwnPropertyDescriptor(global, key)]),
    );
    const result = await setup(global, options);
    installWebApis(global, global.jsdom.window);
    return {
      async teardown(target) {
        try {
          await result.teardown(target);
        } finally {
          for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(target, key, descriptor);
            else Reflect.deleteProperty(target, key);
          }
        }
      },
    };
  };
  if (setupVM) {
    environment.setupVM = async (options) => {
      const result = await setupVM(options);
      const context = result.getVmContext();
      installWebApis(context, context.jsdom.window);
      return result;
    };
  }
}
