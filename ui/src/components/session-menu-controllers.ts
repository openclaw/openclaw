import { createEffect, onCleanup, onSettled, untrack } from "solid-js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";

type SessionMenuController = {
  hostConnected?(): void;
  hostDisconnected?(): void;
  hostUpdate?(): void;
};

/** Adapt the shared menu owners' connection/update hooks to the Solid lifetime. */
export function useSessionMenuControllers(
  host: HTMLElement & { readonly updateComplete: Promise<boolean> },
  context: ApplicationContext | undefined,
  invalidate: () => void,
  dependencies: () => unknown,
) {
  const controllers = new Set<SessionMenuController>();
  const controllerHost = Object.assign(host, {
    addController: (controller: SessionMenuController) => {
      controllers.add(controller);
    },
    removeController: (controller: SessionMenuController) => {
      controllers.delete(controller);
    },
    requestUpdate: invalidate,
  });
  const provideContext = (event: HTMLElementEventMap["context-request"]) => {
    if (event.context !== applicationContext || !context) {
      return;
    }
    event.stopPropagation();
    event.callback(context);
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
