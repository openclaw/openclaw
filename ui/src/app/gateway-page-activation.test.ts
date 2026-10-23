/* @vitest-environment jsdom */

import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { startGatewayPageActivation } from "./gateway-page-activation.ts";
import type { ApplicationGatewayPhase } from "./gateway.ts";
import { refreshControlUiServiceWorker } from "./sw-refresh.runtime.ts";

vi.mock("./sw-refresh.runtime.ts", () => ({
  refreshControlUiServiceWorker: vi.fn(async () => false),
}));

afterEach(() => {
  vi.mocked(refreshControlUiServiceWorker).mockClear();
  vi.restoreAllMocks();
});

function setup(phase: ApplicationGatewayPhase, stale = true, hidden = false) {
  const connect = vi.fn();
  const visibility = vi.spyOn(document, "visibilityState", "get");
  visibility.mockReturnValue(hidden ? "hidden" : "visible");
  const snapshot = { phase, client: { needsWakeReconnect: stale } };
  const dispose = startGatewayPageActivation({ snapshot, connect }, document, window);
  onTestFinished(dispose);
  const foreground = () => {
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
  };
  return { connect, visibility, dispose, foreground };
}
const online = () => window.dispatchEvent(new Event("online"));
const pageshow = (persisted: boolean) =>
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted }));

it.each(["stopped", "offline", "reload-required"] as const)(
  "preserves %s across page restoration, online, and visibility signals",
  async (phase: ApplicationGatewayPhase) => {
    const { connect, visibility, foreground } = setup(phase);
    for (const activate of [
      () => pageshow(true),
      online,
      () => {
        visibility.mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
        foreground();
      },
    ]) {
      const refreshed = Promise.withResolvers<void>();
      vi.mocked(refreshControlUiServiceWorker).mockImplementationOnce(async () => {
        refreshed.resolve();
        return false;
      });
      activate();
      await refreshed.promise;
    }
    expect(connect).not.toHaveBeenCalled();
    expect(refreshControlUiServiceWorker).toHaveBeenCalledTimes(3);
  },
);

it.each([
  ["reconnecting", true, 1],
  ["connected", false, 0],
] as const)("coalesces online/foreground signals for a %s client", async (phase, stale, calls) => {
  const { connect, foreground } = setup(phase, stale, stale);
  if (stale) {
    foreground();
  }
  online();
  await Promise.resolve();
  expect(connect).toHaveBeenCalledTimes(calls);
  await vi.waitFor(() => expect(refreshControlUiServiceWorker).toHaveBeenCalledOnce());
});

it("ignores initial pageshow and removes every listener on dispose", async () => {
  const { connect, dispose } = setup("connecting");
  pageshow(false);
  await Promise.resolve();
  expect(connect).not.toHaveBeenCalled();

  dispose();
  pageshow(true);
  online();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  expect(connect).not.toHaveBeenCalled();
  expect(refreshControlUiServiceWorker).not.toHaveBeenCalled();
});
