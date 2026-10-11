import type { ReactiveController, ReactiveControllerHost } from "lit";
import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";

/** Keep request epochs with the existing owner while its render host migrates. */
export function useGatewayPage(options: ConstructorParameters<typeof GatewayPageController>[1]) {
  const controllers = new Set<ReactiveController>();
  const [revision, setRevision] = createSignal(0);
  let connected = false;
  const host: ReactiveControllerHost = {
    addController(controller) {
      controllers.add(controller);
      if (connected) {
        controller.hostConnected?.();
      }
    },
    removeController(controller) {
      controllers.delete(controller);
    },
    requestUpdate() {
      if (connected) {
        setRevision((value) => value + 1);
      }
    },
    get updateComplete() {
      return Promise.resolve(true);
    },
  };
  const gateway = new GatewayPageController(host, {
    ...options,
    invalidateRequests: (change) => {
      if (connected) {
        options.invalidateRequests?.(change);
      }
    },
  });
  createEffect(
    () => [options.getGateway(), revision()] as const,
    () => {
      untrack(() => {
        if (!connected) {
          connected = true;
          for (const controller of controllers) {
            controller.hostConnected?.();
          }
        } else {
          for (const controller of controllers) {
            controller.hostUpdate?.();
          }
        }
      });
    },
  );
  onCleanup(() => {
    connected = false;
    for (const controller of controllers) {
      controller.hostDisconnected?.();
    }
    controllers.clear();
  });
  return { gateway, host, revision };
}
