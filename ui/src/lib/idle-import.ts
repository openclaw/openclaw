export function createIdleImport<T>(importModule: () => Promise<T>, onLoaded?: (value: T) => void) {
  let moduleLoad: Promise<T> | null = null;
  let active = false;

  const requireActive = () => {
    if (!active) {
      throw new DOMException("Idle import disposed", "AbortError");
    }
  };

  const run = (): Promise<T> => {
    // Recovery is already resident when the app mounts these idle consumers;
    // keep it out of the earlier connection bundle that also shares this loader.
    moduleLoad ??= import("../app/stale-chunk-reload.ts")
      .then(({ retryControlUiImport }) => {
        return retryControlUiImport(() => {
          requireActive();
          return importModule();
        });
      })
      .then((value) => {
        requireActive();
        onLoaded?.(value);
        return value;
      })
      .catch((error: unknown) => {
        // A failed chunk fetch must not pin a rejected promise forever.
        moduleLoad = null;
        throw error;
      });
    return moduleLoad;
  };

  const start = () => active && void run().catch(() => undefined);

  const scheduleIdle = () => {
    if (moduleLoad) {
      return;
    }
    if ("requestIdleCallback" in window) {
      requestIdleCallback(start, { timeout: 3000 });
    } else {
      setTimeout(start, 1500);
    }
  };

  return {
    schedule: (): void => {
      active = true;
      scheduleIdle();
    },
    load: (): Promise<T> => {
      active = true;
      return run();
    },
    dispose: () => {
      active = false;
    },
  };
}
