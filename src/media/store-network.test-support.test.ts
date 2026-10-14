import { AsyncResource } from "node:async_hooks";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  disposeStoreRemoteFixtures,
  withStoreRemoteFixture,
  wrapStoreSaveRemoteMedia,
} from "./store-network.test-support.js";

type SaveRemoteMedia = typeof import("./fetch.js").saveRemoteMedia;
type RemoteMediaOptions = Parameters<SaveRemoteMedia>[0];

afterAll(disposeStoreRemoteFixtures);

function captureSave() {
  const result = { id: "fixture.bin", path: "/fixture/fixture.bin", size: 7 };
  const save = vi.fn<SaveRemoteMedia>(async () => result);
  return { save, wrapped: wrapStoreSaveRemoteMedia(save), result };
}

describe("store remote fixture routing", () => {
  it("routes only the exact active URL and preserves outside and unmatched option identities", async () => {
    const { save, wrapped, result } = captureSave();
    const options: RemoteMediaOptions = {
      url: "http://127.0.0.1:43123/fixture.bin?case=one",
      subdir: "fixture",
      maxBytes: 32,
      requestInit: { headers: { Accept: "application/octet-stream" } },
    };
    expect(await wrapped(options)).toBe(result);
    expect(save.mock.calls[0]?.[0]).toBe(options);
    const matched = vi.fn();
    const unmatched = [
      { ...options, url: "http://127.0.0.1:43123/other.bin?case=one" },
      { ...options, url: "http://127.0.0.1:43124/fixture.bin?case=one" },
      { ...options, url: "http://127.0.0.1:43123/fixture.bin?case=two" },
    ];
    await withStoreRemoteFixture({ url: options.url, onMatch: matched }, async () => {
      expect(disposeStoreRemoteFixtures).toThrow("Store remote fixtures are still active");
      for (const other of unmatched) {
        await wrapped(other);
        expect(save.mock.lastCall?.[0]).toBe(other);
      }
      expect(await wrapped(options)).toBe(result);
      const received = save.mock.lastCall?.[0];
      expect(received).toEqual({
        ...options,
        ssrfPolicy: { allowedOrigins: ["http://127.0.0.1:43123"] },
      });
      expect(received?.requestInit).toBe(options.requestInit);
    });
    expect(matched).toHaveBeenCalledExactlyOnceWith(options.url);
    await wrapped(options);
    expect(save.mock.lastCall?.[0]).toBe(options);
  });

  it("retires routing for a delayed descendant after the owning operation settles", async () => {
    const { save, wrapped } = captureSave();
    const options = { url: "http://127.0.0.1:43123/fixture.bin" };
    const gate = createDeferred();
    let late: ReturnType<SaveRemoteMedia> | undefined;
    await withStoreRemoteFixture({ url: options.url }, async () => {
      late = gate.promise.then(() => wrapped(options));
    });
    gate.resolve();
    await late;
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.lastCall?.[0]).toBe(options);
  });

  it.each(["lookup", "policy"] as const)(
    "rejects a matching call with pre-existing %s options before delegation",
    async (kind) => {
      const { save, wrapped } = captureSave();
      const matched = vi.fn();
      const options: RemoteMediaOptions = {
        url: "http://127.0.0.1:43123/fixture.bin",
        ...(kind === "lookup"
          ? { lookupFn: async () => [] }
          : { ssrfPolicy: { allowedOrigins: [] } }),
      };
      await withStoreRemoteFixture({ url: options.url, onMatch: matched }, async () => {
        expect(() => wrapped(options)).toThrow(
          "Store fixture unexpectedly received an existing routing policy",
        );
      });
      expect(matched).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    },
  );

  it("does not route a callback whose async owner was created outside the fixture scope", async () => {
    const { save, wrapped } = captureSave();
    const options = { url: "http://127.0.0.1:43123/fixture.bin" };
    const externalOwner = new AsyncResource("outside-store-fixture");
    try {
      await withStoreRemoteFixture({ url: options.url }, async () => {
        await externalOwner.runInAsyncScope(() => wrapped(options));
      });
      expect(save.mock.lastCall?.[0]).toBe(options);
    } finally {
      externalOwner.emitDestroy();
    }
  });

  it("preserves a failed operation and leaves later default requests unmodified", async () => {
    const { save, wrapped } = captureSave();
    const options = { url: "http://127.0.0.1:43123/fixture.bin" };
    const failure = new Error("fixture operation failed");
    await expect(
      withStoreRemoteFixture({ url: options.url }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await wrapped(options);
    expect(save.mock.lastCall?.[0]).toBe(options);
  });
});
