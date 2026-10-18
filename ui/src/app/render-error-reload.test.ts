import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import { createStorageMock } from "../test-helpers/storage.ts";
import { registerControlUiReloadGuard } from "./document-reload-guard.ts";
import { reloadAfterRenderErrorOnce } from "./stale-chunk-reload.ts";

const documentFetch = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.useFakeTimers();
  documentFetch.mockReset().mockResolvedValue(new Response("ok"));
  vi.stubGlobal("fetch", documentFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("reloadAfterRenderErrorOnce", () => {
  it("persists before navigation and refuses later attempts, even after the cooldown", async () => {
    const storage = createStorageMock();
    const fetchMock = documentFetch;
    const reload = vi.fn(() => {
      expect(storage.getItem("openclaw.controlUi.renderErrorReloadAttempted")).toBe("1");
    });
    expect(await reloadAfterRenderErrorOnce({ storage, reload })).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await reloadAfterRenderErrorOnce({ storage, reload })).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["missing", "read", "write"])("does not reload with %s storage", async (failure) => {
    const storage = failure === "missing" ? null : createStorageMock();
    if (storage && failure === "read") {
      vi.spyOn(storage, "getItem").mockImplementation(() => {
        throw new Error("unavailable");
      });
    }
    if (storage && failure === "write") {
      vi.spyOn(storage, "setItem").mockImplementation(() => {
        throw new Error("quota");
      });
    }
    const reload = vi.fn();
    expect(await reloadAfterRenderErrorOnce({ storage, reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("leaves the error visible when the document is unreachable", async () => {
    const storage = createStorageMock();
    documentFetch.mockResolvedValue(new Response("offline", { status: 503 }));
    const reload = vi.fn();
    expect(await reloadAfterRenderErrorOnce({ storage, reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(storage.length).toBe(0);
  });

  it.each(["surface", "draft"])("rechecks %s ownership after the probe", async (blocked) => {
    const storage = createStorageMock();
    const response = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => response.promise),
    );
    const reload = vi.fn();
    let current = true;
    let safe = true;
    const release = registerControlUiReloadGuard(() => safe, vi.fn());
    try {
      const pending = reloadAfterRenderErrorOnce({ storage, reload, canReload: () => current });
      if (blocked === "surface") {
        current = false;
      } else {
        safe = false;
      }
      response.resolve(new Response("ok"));
      expect(await pending).toBe(false);
      expect(reload).not.toHaveBeenCalled();
      expect(storage.length).toBe(0);
    } finally {
      release();
    }
  });

  it("admits only one of two failing surfaces sharing a document probe", async () => {
    const storage = createStorageMock();
    const response = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => response.promise),
    );
    const reload = vi.fn();
    const first = reloadAfterRenderErrorOnce({ storage, reload });
    const second = reloadAfterRenderErrorOnce({ storage, reload });
    response.resolve(new Response("ok"));
    expect(await Promise.all([first, second])).toEqual([true, false]);
    expect(reload).toHaveBeenCalledOnce();
  });
});
