import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, onTestFinished, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import * as payloads from "./durable-composer-persistence.ts";

export function useChatSendBrowserFixture(): void {
  beforeEach(() => {
    // Child hosts and storage retire before their browser globals.
    onTestFinished(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });
    installOutboxBrowserStorage();
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
  });
}

function createDocumentLocks() {
  const held = new Set<string>();
  return {
    async request(
      name: string,
      options: LockOptions,
      callback: (lock: Lock | null) => unknown,
    ): Promise<unknown> {
      if (!options.ifAvailable || (options.mode && options.mode !== "exclusive")) {
        throw new Error("The outbox fixture supports exclusive ifAvailable locks only");
      }
      if (held.has(name)) {
        return callback(null);
      }
      held.add(name);
      try {
        return await callback({ name, mode: "exclusive" });
      } finally {
        held.delete(name);
      }
    },
  };
}

// The cached tab claim and its lock share the document's lifetime, even when a
// test replaces storage. Reinstall the same manager for the same navigator.
const documentLocks = new WeakMap<Navigator, ReturnType<typeof createDocumentLocks>>();

/** Node send tests exercise IDB transactions and lock ownership; native FileReader lives in E2E. */
export function installOutboxBrowserStorage(): void {
  const factory = new IDBFactory();
  vi.stubGlobal("indexedDB", factory);
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("File", NodeFile);
  const browserNavigator = navigator;
  const descriptor = Object.getOwnPropertyDescriptor(browserNavigator, "locks");
  const locks = documentLocks.get(browserNavigator) ?? createDocumentLocks();
  documentLocks.set(browserNavigator, locks);
  Object.defineProperty(browserNavigator, "locks", { configurable: true, value: locks });
  const restoreLocks = () => {
    if (descriptor) {
      Object.defineProperty(browserNavigator, "locks", descriptor);
    } else {
      Reflect.deleteProperty(browserNavigator, "locks");
    }
  };
  vi.spyOn(payloads, "readBlobAsDataUrl").mockImplementation(
    async (blob) =>
      `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString("base64")}`,
  );
  onTestFinished(async () => {
    try {
      const request = factory.deleteDatabase("openclaw-control-ui");
      await new Promise<void>((resolve, reject) => {
        request.onsuccess = () => resolve();
        request.addEventListener("error", () =>
          reject(request.error ?? new Error("IndexedDB request failed")),
        );
      });
    } finally {
      restoreLocks();
    }
  });
}
