export type ScheduleReloadOptions = {
  delayMs: number;
  globalRef?: Pick<typeof globalThis, "setTimeout"> & {
    location?: {
      reload?: () => void;
    };
  };
};

export function scheduleLocationReload(opts: ScheduleReloadOptions): void {
  const { delayMs, globalRef = globalThis } = opts;
  const reload = globalRef.location?.reload;
  if (typeof reload !== "function") {
    return;
  }
  globalRef.setTimeout(() => {
    try {
      reload.call(globalRef.location);
    } catch {
      // Ignore reload failures (e.g., test environments or navigation restrictions).
    }
  }, delayMs);
}
