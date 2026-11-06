/* @vitest-environment node */
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  generateOwnerDeviceKey,
  loadOwnerDeviceSigner,
  saveOwnerDeviceKey,
  subscribeOwnerDeviceKey,
} from "./device-key.ts";

describe("owner device key storage", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not report a key saved when its transaction aborts after the write", async () => {
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      const request = put.apply(this, args);
      // The write itself succeeds; the transaction holding it is then lost.
      request.addEventListener("success", () => this.transaction.abort());
      return request;
    });
    const notified = vi.fn();
    const unsubscribe = subscribeOwnerDeviceKey(notified);
    const { pair } = await generateOwnerDeviceKey();
    await expect(saveOwnerDeviceKey("synthetic-claw", pair)).rejects.toThrow();
    unsubscribe();
    expect(notified).not.toHaveBeenCalled();
    expect(await loadOwnerDeviceSigner("synthetic-claw")).toBeUndefined();
  });
});
