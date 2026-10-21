import { AsyncResource } from "node:async_hooks";
import { afterAll, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  disposeStoreRemoteFixtures,
  withStoreRemoteFixture,
  wrapStoreSaveRemoteMedia,
} from "./store-network.test-support.js";

type SaveRemoteMedia = typeof import("./fetch.js").saveRemoteMedia;
type RemoteMediaOptions = Parameters<SaveRemoteMedia>[0];

afterAll(disposeStoreRemoteFixtures);

function captureSave(overrides: Partial<RemoteMediaOptions> = {}) {
  const result = { id: "fixture.bin", path: "/fixture/fixture.bin", size: 7 };
  const save = vi.fn<SaveRemoteMedia>(async () => result);
  const options: RemoteMediaOptions = { url: "http://127.0.0.1:43123/fixture.bin", ...overrides };
  return { save, wrapped: wrapStoreSaveRemoteMedia(save), result, options };
}

it("routes only the exact active URL and preserves outside and unmatched option identities", async () => {
  const { save, wrapped, result, options } = captureSave({
    url: "http://127.0.0.1:43123/fixture.bin?case=one",
    requestInit: { headers: { Accept: "application/octet-stream" } },
  });
  expect(await wrapped(options)).toBe(result);
  expect(save.mock.calls[0]?.[0]).toBe(options);
  const matched = vi.fn();
  await withStoreRemoteFixture({ url: options.url, onMatch: matched }, async () => {
    expect(disposeStoreRemoteFixtures).toThrow("Store remote fixtures are still active");
    for (const url of [
      "http://127.0.0.1:43123/other.bin?case=one",
      "http://127.0.0.1:43124/fixture.bin?case=one",
      "http://127.0.0.1:43123/fixture.bin?case=two",
    ]) {
      const other = { ...options, url };
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
  const { save, wrapped, options } = captureSave();
  const gate = createDeferred();
  const { late } = await withStoreRemoteFixture({ url: options.url }, async () => ({
    late: gate.promise.then(() => wrapped(options)),
  }));
  gate.resolve();
  await late;
  expect(save).toHaveBeenCalledOnce();
  expect(save.mock.lastCall?.[0]).toBe(options);
});

it.each(["lookup", "policy"] as const)(
  "rejects existing %s routing before delegation",
  async (kind) => {
    const { save, wrapped, options } = captureSave(
      kind === "lookup" ? { lookupFn: async () => [] } : { ssrfPolicy: { allowedOrigins: [] } },
    );
    const matched = vi.fn();
    await withStoreRemoteFixture({ url: options.url, onMatch: matched }, async () => {
      expect(() => wrapped(options)).toThrow(
        "Store fixture unexpectedly received an existing routing policy",
      );
    });
    expect(matched).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  },
);

it("does not route an outside async owner", async ({ onTestFinished }) => {
  const { save, wrapped, options } = captureSave();
  const externalOwner = new AsyncResource("outside-store-fixture");
  onTestFinished(() => {
    externalOwner.emitDestroy();
  });
  await withStoreRemoteFixture({ url: options.url }, async () => {
    await externalOwner.runInAsyncScope(() => wrapped(options));
  });
  expect(save.mock.lastCall?.[0]).toBe(options);
});

it("preserves a failed operation and leaves later default requests unmodified", async () => {
  const { save, wrapped, options } = captureSave();
  const failure = new Error("fixture operation failed");
  await expect(
    withStoreRemoteFixture({ url: options.url }, () => Promise.reject(failure)),
  ).rejects.toBe(failure);
  await wrapped(options);
  expect(save.mock.lastCall?.[0]).toBe(options);
});
