import type { ReactiveController, ReactiveControllerHost } from "lit";
import { createEffect, onCleanup, onSettled, untrack } from "solid-js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";

/** Shared menu controllers remain live while their last Lit consumers migrate. */
export function useSessionMenuControllers(
  host: HTMLElement & { readonly updateComplete: Promise<unknown> },
  context: ApplicationContext | undefined,
  invalidate: () => void,
  dependencies: () => unknown,
) {
  const controllers = new Set<ReactiveController>();
  const controllerHost = Object.assign(host, {
    addController: (controller: ReactiveController) => controllers.add(controller),
    removeController: (controller: ReactiveController) => controllers.delete(controller),
    requestUpdate: invalidate,
  }) satisfies ReactiveControllerHost;
  const provideContext = (event: Event) => {
    if (!("context" in event) || event.context !== applicationContext || !context) {
      return;
    }
    const request = event as Event & {
      callback: (value: ApplicationContext) => void;
    };
    request.stopPropagation();
    request.callback(context);
  };
  host.addEventListener("context-request", provideContext);
  createEffect(dependencies, () => {
    // Dependencies are captured above; legacy controllers synchronously read current owner facts.
    untrack(() => {
      for (const controller of controllers) {
        controller.hostUpdate?.();
      }
    });
  });
  onSettled(() => {
    for (const controller of controllers) {
      controller.hostConnected?.();
    }
    invalidate();
  });
  onCleanup(() => {
    for (const controller of controllers) {
      controller.hostDisconnected?.();
    }
    host.removeEventListener("context-request", provideContext);
  });
  return controllerHost;
}
