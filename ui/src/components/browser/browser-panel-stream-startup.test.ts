import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { stubScreenshotMedia } from "./browser-panel-controller-test-support.ts";
import {
  deferImages,
  flush,
  minted,
  ready,
  StartupSocket,
  streamFixture,
} from "./browser-panel-stream.test-support.ts";
import { screencastFrame } from "./browser-screencast-test-support.ts";

const { setup: setupStream, sockets } = streamFixture(StartupSocket, true);
async function setup(mint: Promise<unknown> = Promise.resolve(minted)) {
  const state = setupStream(async (request) => (request.path === "/screencast" ? mint : undefined));
  const pending = state.controller.refreshAll();
  await flush();
  return { ...state, pending };
}

describe("Browser panel stream startup lifetime", () => {
  it.each(["mint", "connecting", "progressing"] as const)(
    "waits through slow %s, then retires it before one bounded fallback",
    async (phase) => {
      const mint = createDeferred<unknown>();
      const { controller, calls, pending } = await setup(
        phase === "connecting" ? undefined : mint.promise,
      );
      const socket = sockets[0];
      await vi.advanceTimersByTimeAsync(1501);
      expect(calls("/screenshot")).toHaveLength(0);
      expect(controller.loading).toBe(true);
      const signal = calls("/screencast")[0]?.[2]?.signal;
      expect(signal?.aborted).toBe(false);
      if (phase === "progressing") {
        await vi.advanceTimersByTimeAsync(8499);
        expect(calls("/screenshot")).toHaveLength(0);
        mint.resolve(minted);
        await flush();
        await vi.advanceTimersByTimeAsync(10_000);
        sockets[0]!.open();
        await vi.advanceTimersByTimeAsync(9000);
        sockets[0]!.receive(ready);
        expect(calls("/screenshot")).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1000);
      } else {
        await vi.advanceTimersByTimeAsync(28_499);
      }
      await pending;
      expect(signal?.aborted).toBe(true);
      expect(calls("/screenshot")).toHaveLength(1);
      expect(controller.loading).toBe(false);
      const fallback = controller.view;
      if (phase === "mint") {
        mint.resolve(minted);
        await flush();
        expect(sockets).toHaveLength(0);
      } else {
        const retired = socket ?? sockets[0]!;
        expect(retired.close).toHaveBeenCalledOnce();
        retired.receive(screencastFrame());
        await flush();
        expect(controller.view).toBe(fallback);
      }
      await vi.advanceTimersByTimeAsync(9999);
      expect(calls("/screencast")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls("/screencast")).toHaveLength(2);
    },
  );

  it("retires a mint immediately when its panel disconnects and ignores its late response", async () => {
    const mint = createDeferred<unknown>();
    const { controller, calls, pending } = await setup(mint.promise);
    const signal = calls("/screencast")[0]?.[2]?.signal;
    controller.suspendView();
    await pending;
    expect(signal?.aborted).toBe(true);
    mint.resolve(minted);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(0);
    expect(calls("/screenshot")).toHaveLength(0);
    expect(calls("/screencast")).toHaveLength(1);
  });

  it("retires a first frame whose decode stalls without publishing it over fallback", async () => {
    const { controller, calls, pending } = await setup();
    const images = deferImages();
    sockets[0]!.receive(screencastFrame());
    await vi.advanceTimersByTimeAsync(29_999);
    expect(calls("/screenshot")).toHaveLength(0);
    stubScreenshotMedia();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0]!.close).toHaveBeenCalledOnce();
    expect(calls("/screenshot")).toHaveLength(1);
    const fallback = controller.view;
    expect(fallback?.dataUrl).toMatch(/^data:/);
    images[0]!.dispatchEvent(new Event("load"));
    await flush();
    expect(controller.view).toBe(fallback);
  });

  it("keeps a usable static frame without a recurring frame watchdog", async () => {
    const { controller, calls, pending } = await setup();
    sockets[0]!.open();
    sockets[0]!.receive(ready);
    sockets[0]!.receive(screencastFrame());
    await pending;
    const view = controller.view;
    await vi.advanceTimersByTimeAsync(120_000);
    await controller.refreshAll();
    expect(controller.view).toBe(view);
    expect(sockets[0]!.close).not.toHaveBeenCalled();
    expect(calls("/screenshot")).toHaveLength(0);
    expect(calls("/screencast")).toHaveLength(1);
  });
});
