import { vi } from "vitest";
import * as storageAccess from "../local-storage.ts";

export function memoryStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(initial));
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
}

export function stubDocumentNavigation() {
  vi.useFakeTimers();
  const target = window;
  const replace = vi.fn();
  vi.stubGlobal("window", {
    location: { href: target.location.href, replace },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  });
  vi.spyOn(storageAccess, "getSafeSessionStorage").mockReturnValue(memoryStorage());
  return replace;
}

export function dispatchPreloadError(payload: unknown) {
  const event = new Event("vite:preloadError", { cancelable: true });
  Object.defineProperty(event, "payload", { value: payload });
  window.dispatchEvent(event);
}
