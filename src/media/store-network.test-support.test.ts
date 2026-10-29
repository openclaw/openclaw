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
  const save = vi.fn<SaveRemoteMedia>(async () => ({
    id: "fixture.bin",
    path: "/fixture/fixture.bin",
    size: 7,
  }));
  const options: RemoteMediaOptions = { url: "http://127.0.0.1:43123/fixture.bin", ...overrides };
  return { save, wrapped: wrapStoreSaveRemoteMedia(save), options };
}

it("routes only the exact active URL and preserves outside and unmatched option identities", async () => {
  const { save, wrapped, options } = captureSave({
    url: "http://127.0.0.1:43123/fixture.bin?case=one",
    requestInit: { headers: { Accept: "application/octet-stream" } },
  });
  await wrapped(options);
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
    await wrapped(options);
    const received = save.mock.lastCall?.[0];
    expect(received).toEqual({
      ...options,
      ssrfPolicy: { allowedOrigins: ["http://127.0.0.1:43123"] },
    });
  });
  expect(matched).toHaveBeenCalledExactlyOnceWith(options.url);
});

it("retires routing for a delayed descendant after the owning operation settles", async () => {
  const { save, wrapped, options } = captureSave();
  const gate = createDeferred();
  const { late } = await withStoreRemoteFixture({ url: options.url }, async () => ({
    late: gate.promise.then(() => wrapped(options)),
  }));
  gate.resolve();
  await late;
  expect(save.mock.lastCall?.[0]).toBe(options);
});

it.each([{ lookupFn: async () => [] }, { ssrfPolicy: { allowedOrigins: [] } }])(
  "rejects existing routing %j before delegation",
  async (routing) => {
    const { save, wrapped, options } = captureSave(routing);
    const matched = vi.fn();
    await withStoreRemoteFixture({ url: options.url, onMatch: matched }, async () => {
      expect(() => wrapped(options)).toThrow("existing routing policy");
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
