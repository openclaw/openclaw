export function createIdleImport<T>(importModule: () => Promise<T>, onLoaded?: (value: T) => void) {
  let moduleLoad: Promise<T> | null = null;
  let active = false;
  let onlineRetryAttempted = false;

  const run = (): Promise<T> => {
    moduleLoad ??= importModule()
      .then((value) => {
        window.removeEventListener("online", start);
        onLoaded?.(value);
        return value;
      })
      .catch((error: unknown) => {
        // A failed chunk fetch must not pin a rejected promise forever.
        moduleLoad = null;
        if (!active) {
          throw error;
        }
        window.addEventListener("online", start, { once: true });
        if (navigator.onLine && !onlineRetryAttempted) {
          onlineRetryAttempted = true;
          scheduleIdle();
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

  const activate = (immediate: boolean) => {
    active = true;
    onlineRetryAttempted = false;
    return immediate ? run() : scheduleIdle();
  };

  const dispose = () => {
    active = false;
    window.removeEventListener("online", start);
  };

  return { schedule: () => activate(false), load: () => activate(true) as Promise<T>, dispose };
}
