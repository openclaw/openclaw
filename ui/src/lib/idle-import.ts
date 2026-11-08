import { listen } from "./reactive/listener.ts";

export function createIdleImport<T>(importModule: () => Promise<T>, onLoaded?: (value: T) => void) {
  let moduleLoad: Promise<T> | null = null;
  let active = false;
  let onlineRetryAttempted = false;
  let stopOnline: (() => void) | undefined;

  const requireActive = () => {
    if (!active) {
      throw new DOMException("Idle import disposed", "AbortError");
    }
  };

  const run = (): Promise<T> => {
    moduleLoad ??= importModule()
      .catch(async (error: unknown) => {
        const { retryFailedControlUiImport } = await import("../app/stale-chunk-reload.ts");
        return retryFailedControlUiImport(error, () => {
          requireActive();
          return importModule();
        });
      })
      .then((value) => {
        requireActive();
        stopOnline?.();
        onLoaded?.(value);
        return value;
      })
      .catch((error: unknown) => {
        // A failed chunk fetch must not pin a rejected promise forever.
        moduleLoad = null;
        if (active) {
          stopOnline?.();
          stopOnline = listen(window, "online", start, { once: true });
          if (navigator.onLine && !onlineRetryAttempted) {
            onlineRetryAttempted = true;
            scheduleIdle();
          }
        }
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

  const activate = () => {
    active = true;
    onlineRetryAttempted = false;
  };

  return {
    schedule: (): void => {
      activate();
      scheduleIdle();
    },
    load: (): Promise<T> => {
      activate();
      return run();
    },
    dispose: () => {
      active = false;
      stopOnline?.();
    },
  };
}
