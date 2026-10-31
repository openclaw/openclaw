import { createMemo, createSignal, onSettled } from "solid-js";

/** Append the first render in browser tasks; later owner updates remain fully visible. */
export function createProgressiveList<T>(
  source: () => readonly T[],
  options: { initial: number; batch: number; enabled?: () => boolean },
) {
  const [limit, setLimit] = createSignal(options.initial);
  const enabled = () => options.enabled?.() !== false;
  const pending = () => enabled() && limit() < source().length;
  const items = createMemo(() =>
    !enabled() || limit() === Infinity ? source() : source().slice(0, limit()),
  );

  onSettled(() => {
    if (!enabled() || !pending()) {
      setLimit(Infinity);
      return undefined;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // SAFETY: scheduler.yield is optional; WebKit uses the cancellable timer below.
    const browser = globalThis as typeof globalThis & {
      scheduler?: { yield?: () => Promise<void> };
    };
    const append = async () => {
      while (true) {
        await (browser.scheduler?.yield?.() ??
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 0);
          }));
        if (disposed) {
          return;
        }
        const next = limit() + options.batch;
        if (!enabled() || next >= source().length) {
          setLimit(Infinity);
          return;
        }
        setLimit(next);
      }
    };
    void append();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  });

  return { items, pending };
}
