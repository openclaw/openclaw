import type { JSX } from "@solidjs/web";
import { createRenderEffect } from "solid-js";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import type { SolidPanelOwner } from "./solid-panel-owner.ts";

type BridgeSpec<Props extends object, Methods extends object> = Parameters<
  typeof defineSolidBridge<Props, Methods>
>[2];

/** The bridge owns input properties; the controller reads that same synchronous state. */
export function definePanelBridge<
  Props extends object,
  Controller extends SolidPanelOwner & Record<Method, (...args: never[]) => unknown>,
  Method extends PropertyKey,
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
    const bridgePrototype = Object.getPrototypeOf(host);
    Object.defineProperty(host, "updateComplete", {
      configurable: true,
      get: () =>
        Promise.resolve(Reflect.get(bridgePrototype, "updateComplete", host)).then(
          () => controller.updateComplete,
        ),
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
