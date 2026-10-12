import { createEffect, createMemo, createSignal, onCleanup, onSettled, untrack } from "solid-js";

export type SolidController = {
  hostConnected?(): void;
  hostDisconnected?(): void;
  hostUpdate?(): void;
  hostUpdated?(): void;
};

export type SolidControllerHost = {
  addController(controller: SolidController): void;
  removeController(controller: SolidController): void;
  requestUpdate(): void;
  readonly updateComplete: Promise<boolean>;
};

/** Keeps imperative controllers in their existing owner while Solid renders their facts. */
export function useSolidControllerHost(dependencies?: () => unknown) {
  const controllers = new Set<SolidController>();
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  let connected = false;
  let updating = false;
  let disposed = false;
  const host: SolidControllerHost = {
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
      // Like Lit's willUpdate, changes during owner reconciliation belong to this commit.
      if (!updating && !disposed) {
        setRevision((value) => value + 1);
      }
    },
    get updateComplete() {
      return Promise.resolve(true);
    },
  };
  // Reconcile before the view reads the imperative owner's fields. A split effect
  // applies after JSX computations, which would publish the previous owner state.
  const prepared = createMemo(
    () => {
      dependencies?.();
      const value = revision();
      if (connected) {
        updating = true;
        try {
          untrack(() => {
            for (const controller of controllers) {
              controller.hostUpdate?.();
            }
          });
        } finally {
          updating = false;
        }
      }
      return value;
    },
    { equals: false },
  );
  createEffect(prepared, () => {
    if (connected) {
      untrack(() => {
        for (const controller of controllers) {
          controller.hostUpdated?.();
        }
      });
    }
  });
  onSettled(() => {
    connected = true;
    untrack(() => {
      for (const controller of controllers) {
        controller.hostConnected?.();
      }
    });
    host.requestUpdate();
  });
  onCleanup(() => {
    disposed = true;
    connected = false;
    untrack(() => {
      for (const controller of controllers) {
        controller.hostDisconnected?.();
      }
    });
    controllers.clear();
  });
  return { host, revision: prepared };
}
