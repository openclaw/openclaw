import { createEffect, onCleanup, onSettled, untrack } from "solid-js";

type SessionMenuController = {
  hostConnected?(): void;
  hostDisconnected?(): void;
  hostUpdate?(): void;
};

/** Adapt the shared menu owners' connection/update hooks to the Solid lifetime. */
export function useSessionMenuControllers(
  host: HTMLElement & { readonly updateComplete: Promise<boolean> },
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
  });
  return controllerHost;
}
