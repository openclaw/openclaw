/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readGatewayVersionFromSnapshot,
  resolveStaleBundleGatewayVersion,
  STALE_BUNDLE_IDLE_RELOAD_MS,
  StaleBundleReloadController,
} from "./stale-bundle.ts";

function setDocumentActivityState(visibility: DocumentVisibilityState, focused: boolean) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: visibility });
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
}

describe("stale bundle detection", () => {
  it("reads the gateway self version from the hello snapshot", () => {
    expect(
      readGatewayVersionFromSnapshot({
        presence: [
          { mode: "node", version: "2026.7.9" },
          { mode: "gateway", reason: "proxy", version: "2026.7.99" },
          { mode: " Gateway ", reason: "self", version: " 2026.7.11 " },
        ],
      }),
    ).toBe("2026.7.11");
    expect(
      readGatewayVersionFromSnapshot({ presence: [{ mode: "node", version: "x" }] }),
    ).toBeNull();
  });

  it("returns the normalized gateway version only when it differs from the bundle", () => {
    expect(resolveStaleBundleGatewayVersion(" 2026.7.11 ", "2026.7.10")).toBe("2026.7.11");
    expect(resolveStaleBundleGatewayVersion("2026.7.10", " 2026.7.10 ")).toBeNull();
    expect(resolveStaleBundleGatewayVersion("", "2026.7.10")).toBeNull();
    expect(resolveStaleBundleGatewayVersion("2026.7.11", null)).toBeNull();
  });
});

describe("StaleBundleReloadController", () => {
  const controllers: StaleBundleReloadController[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    for (const controller of controllers.splice(0)) {
      controller.stop();
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function createController(prepareReload = vi.fn(() => true)) {
    const reload = vi.fn();
    const controller = new StaleBundleReloadController({ prepareReload, reload });
    controllers.push(controller);
    return { controller, prepareReload, reload };
  }

  it("reloads an idle background tab after preparing its composer draft", async () => {
    setDocumentActivityState("hidden", false);
    const { controller, prepareReload, reload } = createController();
    controller.update("2026.7.11");

    await vi.advanceTimersByTimeAsync(STALE_BUNDLE_IDLE_RELOAD_MS);

    expect(prepareReload).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("never reloads a visible focused tab", async () => {
    setDocumentActivityState("visible", true);
    const { controller, prepareReload, reload } = createController();
    controller.update("2026.7.11");

    await vi.advanceTimersByTimeAsync(STALE_BUNDLE_IDLE_RELOAD_MS * 2);

    expect(prepareReload).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("resets the idle window on user activity", async () => {
    setDocumentActivityState("hidden", false);
    const { controller, reload } = createController();
    controller.update("2026.7.11");
    await vi.advanceTimersByTimeAsync(STALE_BUNDLE_IDLE_RELOAD_MS - 1_000);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reload).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(STALE_BUNDLE_IDLE_RELOAD_MS - 1_000);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does not reload when composer state cannot be persisted safely", async () => {
    setDocumentActivityState("hidden", false);
    const { controller, prepareReload, reload } = createController(vi.fn(() => false));
    controller.update("2026.7.11");

    await vi.advanceTimersByTimeAsync(STALE_BUNDLE_IDLE_RELOAD_MS);

    expect(prepareReload).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
  });

  it("tears down the idle timer when the mismatch disconnects", async () => {
    setDocumentActivityState("hidden", false);
    const { controller, prepareReload, reload } = createController();
    controller.update("2026.7.11");
    controller.update(null);

    await vi.advanceTimersByTimeAsync(STALE_BUNDLE_IDLE_RELOAD_MS);

    expect(prepareReload).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});
