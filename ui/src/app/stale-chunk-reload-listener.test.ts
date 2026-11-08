import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";
import { dispatchPreloadError, stubDocumentNavigation } from "./stale-chunk-reload.test-support.ts";
import {
  cancelStaleChunkRecovery,
  installStaleChunkReloadListener,
  retryControlUiImport,
  scheduleStaleChunkReload,
} from "./stale-chunk-reload.ts";

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000 });
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(async () => {
  cancelStaleChunkRecovery();
  await vi.advanceTimersByTimeAsync(0);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("installStaleChunkReloadListener", () => {
  it("keeps ordinary recovery available after confirming the same build", async () => {
    const replace = stubDocumentNavigation();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async (_input, init) =>
          new Response(
            init?.method === "HEAD"
              ? null
              : `<script>globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO=${JSON.stringify(CONTROL_UI_BUILD_INFO)};</script>`,
          ),
      ),
    );
    const uninstall = installStaleChunkReloadListener();
    try {
      dispatchPreloadError(new Error("Importing a module script failed."));
      await vi.advanceTimersByTimeAsync(0);
      expect(replace).not.toHaveBeenCalled();
      await expect(scheduleStaleChunkReload()).resolves.toBe(true);
      expect(replace).toHaveBeenCalledTimes(1);
    } finally {
      uninstall();
    }
  });

  it.each(["dismiss", "reload"])(
    "retires a pending build decision when its surface requests %s",
    async (action) => {
      const replace = stubDocumentNavigation();
      const document = deferred<Response>();
      const fetchMock = vi.fn<typeof fetch>(async (_input, init) =>
        init?.method === "HEAD" ? new Response(null) : document.promise,
      );
      vi.stubGlobal("fetch", fetchMock);
      const uninstall = installStaleChunkReloadListener();
      try {
        dispatchPreloadError(new Error("Importing a module script failed."));
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        if (action === "dismiss") {
          cancelStaleChunkRecovery();
        } else {
          await expect(scheduleStaleChunkReload()).resolves.toBe(true);
        }
        document.resolve(
          new Response(
            '<script>globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO={"buildId":"new-build"};</script>',
          ),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(replace).toHaveBeenCalledTimes(action === "dismiss" ? 0 : 1);
        if (action === "dismiss") {
          fetchMock.mockImplementation(
            async (_input, init) =>
              new Response(
                init?.method === "HEAD"
                  ? null
                  : '<script>globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO={"buildId":"new-build"};</script>',
              ),
          );
          dispatchPreloadError(new Error("Importing a module script failed."));
          await vi.advanceTimersByTimeAsync(0);
          expect(replace).toHaveBeenCalledTimes(1);
        }
      } finally {
        uninstall();
      }
    },
  );

  it.each([
    { changed: false, retry: false },
    { changed: true, retry: false },
    { changed: false, retry: true },
    { changed: true, retry: true },
  ])(
    "recovers background imports by build identity (changed: $changed, retried: $retry)",
    async ({ changed, retry }) => {
      const replace = stubDocumentNavigation();
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new TypeError("offline"))
        .mockImplementation(
          async (_input, init) =>
            new Response(
              init?.method === "HEAD"
                ? null
                : `<script>globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO=${JSON.stringify({ buildId: changed ? "updated-build" : CONTROL_UI_BUILD_INFO.buildId })};</script>`,
            ),
        );
      vi.stubGlobal("fetch", fetchMock);
      const uninstall = installStaleChunkReloadListener();
      try {
        dispatchPreloadError(new Error("boom in module evaluation"));
        expect(fetchMock).not.toHaveBeenCalled();
        const error = new Error("Importing a module script failed.");
        const load = vi.fn(async () => {
          dispatchPreloadError(error);
          throw error;
        });
        const completion = retry
          ? retryControlUiImport(load).catch(() => undefined)
          : load().catch(() => undefined);
        await vi.advanceTimersByTimeAsync(0);
        await vi.dynamicImportSettled();
        expect(replace).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_000);
        await completion;
        await vi.advanceTimersByTimeAsync(1);
        await vi.dynamicImportSettled();
        expect(replace).toHaveBeenCalledTimes(changed ? 1 : 0);
        expect(load).toHaveBeenCalledTimes(retry ? 2 : 1);
      } finally {
        uninstall();
      }
    },
  );
});
