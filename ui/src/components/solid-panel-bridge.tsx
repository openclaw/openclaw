import type { JSX } from "@solidjs/web";
import { createRenderEffect } from "solid-js";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import type { SolidPanelController } from "./solid-panel-controller.ts";

type MethodKey<T> = {
  [Key in keyof T]-?: T[Key] extends (...args: never[]) => unknown ? Key : never;
}[keyof T];

type BridgeSpec<Props extends object, Methods extends object> = Parameters<
  typeof defineSolidBridge<Props, Methods>
>[2];

/** The bridge owns input properties; the controller reads that same synchronous state. */
export function definePanelBridge<
  Props extends object,
  Controller extends SolidPanelController,
  Method extends MethodKey<Controller>,
>(
  tag: string,
  create: (element: HTMLElement) => Controller,
  content: (controller: Controller) => JSX.Element,
  options: {
    properties: BridgeSpec<Props, Pick<Controller, Method>>["properties"];
    methods: readonly Method[];
    getters?: readonly (keyof Controller)[];
  },
) {
  type Host = SolidBridgeElement<Props, Pick<Controller, Method>>;
  const controllers = new WeakMap<HTMLElement, Controller>();
  // SAFETY: the property spec is keyed by Props; Object.keys loses that key relationship.
  const properties = Object.keys(options.properties) as (keyof Props & string)[];
  const controllerFor = (host: Host): Controller => {
    let controller = controllers.get(host);
    if (controller) {
      return controller;
    }
    controller = create(host);
    const inputs: Props = host;
    for (const key of properties) {
      Object.defineProperty(controller, key, {
        configurable: true,
        get: () => inputs[key],
        set: (value: Props[typeof key]) => {
          inputs[key] = value;
        },
      });
    }
    for (const key of options.getters ?? []) {
      Object.defineProperty(host, key, {
        configurable: true,
        get: () => controller[key],
      });
    }
    let prototype = Object.getPrototypeOf(host);
    let bridgeCompletion: PropertyDescriptor["get"];
    while (prototype && !bridgeCompletion) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "updateComplete");
      if (descriptor?.get) {
        bridgeCompletion = descriptor.get.bind(host);
      }
      prototype = Object.getPrototypeOf(prototype);
    }
    if (!bridgeCompletion) {
      throw new Error("Solid panel bridge requires the bridge commit fence");
    }
    const readBridgeCompletion = bridgeCompletion;
    Object.defineProperty(host, "updateComplete", {
      configurable: true,
      get: () => Promise.resolve(readBridgeCompletion()).then(() => controller.updateComplete),
    });
    controllers.set(host, controller);
    return controller;
  };
  const methods = Object.fromEntries(
    options.methods.map((key) => [
      key,
      (host: Host, ...args: unknown[]) => {
        const controller = controllerFor(host);
        const method = controller[key];
        if (typeof method !== "function") {
          throw new TypeError(`Panel method ${String(key)} is not callable`);
        }
        return Reflect.apply(method, controller, args);
      },
    ]),
    // SAFETY: each selected method is forwarded to that same key on its controller.
  ) as BridgeSpec<Props, Pick<Controller, Method>>["methods"];
  return defineSolidBridge<Props, Pick<Controller, Method>>(
    tag,
    (props, host) => {
      const controller = controllerFor(host);
      let previous: unknown[] | undefined;
      createRenderEffect(
        () => properties.map((key) => props[key]),
        (values) => {
          properties.forEach((key, index) => {
            if (!previous || !Object.is(previous[index], values[index])) {
              controller.inputsChanged(key, previous?.[index]);
            }
          });
          previous = values;
        },
      );
      return content(controller);
    },
    { properties: options.properties, methods },
  );
}
