import { vi } from "vitest";

type WatcherHandler = (value?: unknown) => void;
type WatcherEvent = "add" | "change" | "unlink" | "error" | "ready";
const WATCHER_PATH_EVENTS = new Set<WatcherEvent>(["add", "change", "unlink"]);

export function createWatcherMock(effectiveUsePolling?: boolean) {
  const handlers = new Map<WatcherEvent, WatcherHandler[]>();
  const watcher = {
    effectiveUsePolling,
    options: { usePolling: false },
    on(event: WatcherEvent, handler: WatcherHandler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
      return this;
    },
    emit(event: WatcherEvent, value?: unknown) {
      const eventValue =
        value ?? (WATCHER_PATH_EVENTS.has(event) ? "/tmp/openclaw.json" : undefined);
      for (const handler of handlers.get(event) ?? []) {
        handler(eventValue);
      }
    },
    close: vi.fn(async () => {}),
  };
  return watcher;
}
