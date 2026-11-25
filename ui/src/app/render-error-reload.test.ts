import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import { createStorageMock } from "../test-helpers/storage.ts";
import { registerControlUiReloadGuard } from "./document-reload-guard.ts";
import { reloadAfterRenderErrorOnce } from "./stale-chunk-reload.ts";

const documentFetch = vi.fn<typeof fetch>();
let storage: ReturnType<typeof createStorageMock>;
let reload: ReturnType<typeof vi.fn<() => void>>;
const attempt = (options: Parameters<typeof reloadAfterRenderErrorOnce>[0] = {}) =>
  reloadAfterRenderErrorOnce({ storage, reload, ...options });
beforeEach(() => {
  vi.useFakeTimers();
  storage = createStorageMock();
  reload = vi.fn();
  vi.stubGlobal("fetch", documentFetch.mockReset().mockResolvedValue(new Response("ok")));
});
afterEach(() => {
  vi.unstubAllGlobals().restoreAllMocks().useRealTimers();
});

it("persists before navigation and refuses later attempts, even after the cooldown", async () => {
  reload = vi.fn(() => {
    expect(storage.getItem("openclaw.controlUi.renderErrorReloadAttempted")).toBe("1");
  });
  expect(await attempt()).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await attempt()).toBe(false);
  expect(reload).toHaveBeenCalledOnce();
  expect(documentFetch).toHaveBeenCalledOnce();
});

it.each(["missing", "read", "write"])("does not reload with %s storage", async (failure) => {
  if (failure !== "missing") {
    vi.spyOn(storage, failure === "read" ? "getItem" : "setItem").mockImplementation(() => {
      throw new Error("unavailable");
    });
  }
  expect(await attempt({ storage: failure === "missing" ? null : storage })).toBe(false);
  expect(reload).not.toHaveBeenCalled();
});

it("leaves the error visible when the document is unreachable", async () => {
  documentFetch.mockResolvedValue(new Response("offline", { status: 503 }));
  expect(await attempt()).toBe(false);
  expect(reload).not.toHaveBeenCalled();
  expect(storage.length).toBe(0);
});

it.each(["surface", "draft"])("rechecks %s ownership after the probe", async (blocked) => {
  const response = deferred<Response>();
  documentFetch.mockReturnValue(response.promise);
  let allowed = true;
  const release = registerControlUiReloadGuard(() => blocked === "surface" || allowed, vi.fn());
  try {
    const pending = attempt({ canReload: () => blocked === "draft" || allowed });
    allowed = false;
    response.resolve(new Response("ok"));
    expect(await pending).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(storage.length).toBe(0);
  } finally {
    release();
  }
});

it("admits only one of two failing surfaces sharing a document probe", async () => {
  const response = deferred<Response>();
  documentFetch.mockReturnValue(response.promise);
  const pending = Promise.all([attempt(), attempt()]);
  response.resolve(new Response("ok"));
  expect(await pending).toEqual([true, false]);
  expect(reload).toHaveBeenCalledOnce();
});
