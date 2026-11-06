/* @vitest-environment node */
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureOwnerDeviceSigner, loadOwnerDeviceSigner } from "./device-key.ts";

describe("owner device key storage", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("stores the owner key before it is used, and reuses it afterwards", async () => {
    const first = await ensureOwnerDeviceSigner("synthetic-claw");
    expect((await loadOwnerDeviceSigner("synthetic-claw"))?.publicKey).toEqual(first.publicKey);
    expect((await ensureOwnerDeviceSigner("synthetic-claw")).publicKey).toEqual(first.publicKey);
  });

  it("fails when the transaction aborts after the write succeeded", async () => {
    // The real method, captured before the spy replaces it.
    const add: IDBObjectStore["add"] = Reflect.get(IDBObjectStore.prototype, "add");
    vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["add"]>
    ) {
      const request: IDBRequest<IDBValidKey> = Reflect.apply(add, this, args);
      // The write itself succeeds; the transaction holding it is then lost.
      request.addEventListener("success", () => this.transaction.abort());
      return request;
    });
    await expect(ensureOwnerDeviceSigner("synthetic-claw")).rejects.toThrow();
    expect(await loadOwnerDeviceSigner("synthetic-claw")).toBeUndefined();
  });
});
