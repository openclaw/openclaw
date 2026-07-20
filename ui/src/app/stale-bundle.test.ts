/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  gatewayUrlMatchesDocumentOrigin,
  prepareStaleBundleManualReload,
  readGatewayVersionFromSnapshot,
  resolveStaleBundleGatewayVersion,
  resolveStaleBundleReloadPair,
  STALE_BUNDLE_AUTO_RELOAD_STORAGE_KEY,
  STALE_BUNDLE_IDLE_RELOAD_MS,
  StaleBundleReloadController,
  type StaleBundleVersionPair,
} from "./stale-bundle.ts";

const VERSION_PAIR: StaleBundleVersionPair = {
  bundleVersion: "2026.7.10",
  gatewayVersion: "2026.7.11",
};

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

  it("maps WebSocket protocols before comparing the active gateway with the document origin", () => {
    expect(
      gatewayUrlMatchesDocumentOrigin(
        "wss://team.openclaw.ai/gateway",
        "https://team.openclaw.ai/chat",
      ),
    ).toBe(true);
    expect(
      gatewayUrlMatchesDocumentOrigin("ws://127.0.0.1:18789", "http://127.0.0.1:18789/chat"),
    ).toBe(true);
    expect(
      gatewayUrlMatchesDocumentOrigin(
        "wss://gateway.example.test",
        "https://team.openclaw.ai/chat",
      ),
    ).toBe(false);
    expect(gatewayUrlMatchesDocumentOrigin("", "https://team.openclaw.ai/chat")).toBe(false);
    expect(
      gatewayUrlMatchesDocumentOrigin(
        "https://team.openclaw.ai/gateway",
        "https://team.openclaw.ai/chat",
      ),
    ).toBe(false);
  });

  it("only produces an auto-reload pair for a same-origin mismatch", () => {
    expect(
      resolveStaleBundleReloadPair({
        bundleVersion: VERSION_PAIR.bundleVersion,
        gatewayUrl: "wss://team.openclaw.ai/gateway",
        gatewayVersion: VERSION_PAIR.gatewayVersion,
        documentHref: "https://team.openclaw.ai/chat",
      }),
    ).toEqual(VERSION_PAIR);
    expect(
      resolveStaleBundleReloadPair({
        bundleVersion: VERSION_PAIR.bundleVersion,
        gatewayUrl: "wss://gateway.example.test",
        gatewayVersion: VERSION_PAIR.gatewayVersion,
        documentHref: "https://team.openclaw.ai/chat",
      }),
    ).toBeNull();
  });
});

describe("manual stale-bundle reload preparation", () => {
  it("flushes every composer and continues when all state is restorable", () => {
    const prepare = vi.fn(() => "ready" as const);
    const confirmDiscard = vi.fn(() => true);

    expect(
      prepareStaleBundleManualReload([{ prepareForStaleBundleReload: prepare }], confirmDiscard),
    ).toBe(true);
    expect(prepare).toHaveBeenCalledOnce();
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it("requires consent before discarding staged attachments", () => {
    const prepare = vi.fn(() => "attachments" as const);
    const confirmDiscard = vi.fn(() => false);

    expect(
      prepareStaleBundleManualReload([{ prepareForStaleBundleReload: prepare }], confirmDiscard),
    ).toBe(false);
    expect(prepare).toHaveBeenCalledOnce();
    expect(confirmDiscard).toHaveBeenCalledOnce();
  });

  it("does not offer attachment discard when draft persistence is blocked", () => {
    const confirmDiscard = vi.fn(() => true);
    expect(
      prepareStaleBundleManualReload(
        [{ prepareForStaleBundleReload: () => "blocked" }],
        confirmDiscard,
      ),
    ).toBe(false);
    expect(confirmDiscard).not.toHaveBeenCalled();
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

  function createController(
    prepareReload = vi.fn(() => true),
    storage: Storage | null = createStorageMock(),
  ) {
    const reload = vi.fn();
    const controller = new StaleBundleReloadController({ prepareReload, reload, storage });
    controllers.push(controller);
    return { controller, prepareReload, reload, storage };
  }

  it("reloads an idle background tab after preparing its composer draft", async () => {
    setDocumentActivityState("hidden", false);
    const { controller, prepareReload, reload } = createController();
    controller.update(VERSION_PAIR);

    await vi.advanceTimersByTimeAsync(STALE_BUNDLE_IDLE_RELOAD_MS);

    expect(prepareReload).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("never arms auto-reload for a cross-origin gateway mismatch", async () => {
    setDocumentActivityState("hidden", false);
    const { controller, prepareReload, reload } = createController();
    const crossOriginPair = resolveStaleBundleReloadPair({
      bundleVersion: VERSION_PAIR.bundleVersion,
      documentHref: "https://team.openclaw.ai/chat",
      gatewayUrl: "wss://gateway.example.test",
      gatewayVersion: VERSION_PAIR.gatewayVersion,
    });

    controller.update(crossOriginPair);
    await vi.advanceTimersByTimeAsync(STALE_BUNDLE_IDLE_RELOAD_MS * 2);

    expect(prepareReload).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("never reloads a visible focused tab", async () => {
    setDocumentActivityState("visible", true);
    const { controller, prepareReload, reload } = createController();
    controller.update(VERSION_PAIR);

    await vi.advanceTimersByTimeAsync(STALE_BUNDLE_IDLE_RELOAD_MS * 2);

    expect(prepareReload).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("resets the idle window on user activity", async () => {
    setDocumentActivityState("hidden", false);
    const { controller, reload } = createController();
    controller.update(VERSION_PAIR);
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
    controller.update(VERSION_PAIR);

    await vi.advanceTimersByTimeAsync(STALE_BUNDLE_IDLE_RELOAD_MS);

    expect(prepareReload).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
  });

  it("tears down the idle timer when the mismatch disconnects", async () => {
    setDocumentActivityState("hidden", false);
    const { controller, prepareReload, reload } = createController();
    controller.update(VERSION_PAIR);
    controller.update(null);

    await vi.advanceTimersByTimeAsync(STALE_BUNDLE_IDLE_RELOAD_MS);

    expect(prepareReload).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("records every reloaded version pair and does not re-loop through A-B-A", async () => {
    setDocumentActivityState("hidden", false);
    const storage = createStorageMock();
    const first = createController(
      vi.fn(() => true),
      storage,
    );
    first.controller.update(VERSION_PAIR);

    await vi.advanceTimersByTimeAsync(STALE_BUNDLE_IDLE_RELOAD_MS);

    expect(first.reload).toHaveBeenCalledOnce();
    expect(storage.getItem(STALE_BUNDLE_AUTO_RELOAD_STORAGE_KEY)).toBe(
      JSON.stringify([JSON.stringify([VERSION_PAIR.bundleVersion, VERSION_PAIR.gatewayVersion])]),
    );

    const secondPair = { ...VERSION_PAIR, gatewayVersion: "2026.7.12" };
    const interveningReload = createController(
      vi.fn(() => true),
      storage,
    );
    interveningReload.controller.update(secondPair);
    await vi.advanceTimersByTimeAsync(STALE_BUNDLE_IDLE_RELOAD_MS);
    expect(interveningReload.reload).toHaveBeenCalledOnce();

    const repeatedFirstPair = createController(
      vi.fn(() => true),
      storage,
    );
    repeatedFirstPair.controller.update(VERSION_PAIR);
    await vi.advanceTimersByTimeAsync(STALE_BUNDLE_IDLE_RELOAD_MS * 2);

    expect(repeatedFirstPair.prepareReload).not.toHaveBeenCalled();
    expect(repeatedFirstPair.reload).not.toHaveBeenCalled();
  });

  it("suppresses a delayed reload when another controller records the pair first", async () => {
    setDocumentActivityState("hidden", false);
    const storage = createStorageMock();
    const first = createController(
      vi.fn(() => true),
      storage,
    );
    const second = createController(
      vi.fn(() => true),
      storage,
    );
    first.controller.update(VERSION_PAIR);
    second.controller.update(VERSION_PAIR);

    await vi.advanceTimersByTimeAsync(STALE_BUNDLE_IDLE_RELOAD_MS);

    expect(first.reload).toHaveBeenCalledOnce();
    expect(second.reload).not.toHaveBeenCalled();
  });

  it("fails closed when the reload guard cannot be stored", async () => {
    setDocumentActivityState("hidden", false);
    const storage = createStorageMock();
    storage.setItem = () => {
      throw new Error("storage disabled");
    };
    const { controller, reload } = createController(
      vi.fn(() => true),
      storage,
    );
    controller.update(VERSION_PAIR);

    await vi.advanceTimersByTimeAsync(STALE_BUNDLE_IDLE_RELOAD_MS);

    expect(reload).not.toHaveBeenCalled();
  });
});
