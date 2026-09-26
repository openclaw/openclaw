import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeModule = () => import("./control-ui-database.runtime.ts");

function createFakeIndexedDb() {
  const listeners = new Map<string, () => void>();
  const database = {
    objectStoreNames: { contains: () => true },
    addEventListener: vi.fn(),
    close: vi.fn(),
  };
  const request = {
    result: database,
    error: null,
    addEventListener: (type: string, listener: () => void) => {
      listeners.set(type, listener);
    },
  };
  const open = vi.fn(() => request);
  return {
    database,
    open,
    indexedDB: { open } as unknown as IDBFactory,
    succeed: () => listeners.get("success")?.(),
  };
}

const originalIndexedDb = Reflect.get(globalThis, "indexedDB");

beforeEach(() => {
  vi.resetModules();
  Reflect.deleteProperty(globalThis, "indexedDB");
});

afterEach(() => {
  if (originalIndexedDb === undefined) {
    Reflect.deleteProperty(globalThis, "indexedDB");
  } else {
    Reflect.set(globalThis, "indexedDB", originalIndexedDb);
  }
});

describe("openControlUiDatabase", () => {
  it("opens once IndexedDB becomes available after an unavailable first call", async () => {
    const { openControlUiDatabase } = await runtimeModule();
    await expect(openControlUiDatabase()).rejects.toThrow("IndexedDB is unavailable");

    const fake = createFakeIndexedDb();
    Reflect.set(globalThis, "indexedDB", fake.indexedDB);

    const opening = openControlUiDatabase();
    expect(fake.open).toHaveBeenCalledTimes(1);
    fake.succeed();
    await expect(opening).resolves.toBe(fake.database);
  });

  it("reuses one open once IndexedDB is available", async () => {
    const fake = createFakeIndexedDb();
    Reflect.set(globalThis, "indexedDB", fake.indexedDB);
    const { openControlUiDatabase } = await runtimeModule();

    const first = openControlUiDatabase();
    fake.succeed();
    await expect(first).resolves.toBe(fake.database);
    await expect(openControlUiDatabase()).resolves.toBe(fake.database);
    expect(fake.open).toHaveBeenCalledTimes(1);
  });
});
