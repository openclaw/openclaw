/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  gatewayUrlMatchesDocumentOrigin,
  prepareComposerForIdleReload,
  readGatewayVersionFromSnapshot,
  reloadWithComposerGuard,
  resolveStaleBundleReloadPair,
  StaleBundleReloadController,
  type StaleBundleVersionPair,
} from "./stale-bundle.ts";

const TEST_IDLE_MS = 10_000;
// Mirrors the module-local key so storage behavior stays observable without a test-only export.
const AUTO_RELOAD_STORAGE_KEY = "openclaw:control-ui:stale-bundle-auto-reloaded:v1";

const VERSION_PAIR: StaleBundleVersionPair = {
  bundleVersion: "2026.7.10",
  gatewayVersion: "2026.7.11",
};

function setDocumentActivityState(visibility: DocumentVisibilityState, focused: boolean) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: visibility });
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
}

function reloadRoot(...preparations: Array<() => "attachments" | "blocked" | "ready">) {
  const targets = preparations.map((prepareForStaleBundleReload) => ({
    prepareForStaleBundleReload,
  }));
  return {
    querySelectorAll: () => targets,
  } as unknown as ParentNode;
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

  it("normalizes versions and returns only actionable mismatches", () => {
    const input = {
      documentHref: "https://team.openclaw.ai/chat",
      gatewayUrl: "wss://team.openclaw.ai/gateway",
    };
    expect(
      resolveStaleBundleReloadPair({
        ...input,
        bundleVersion: " 2026.7.10 ",
        gatewayVersion: " 2026.7.11 ",
      }),
    ).toEqual(VERSION_PAIR);
    expect(
      resolveStaleBundleReloadPair({
        ...input,
        bundleVersion: " 2026.7.10 ",
        gatewayVersion: "2026.7.10",
      }),
    ).toBeNull();
    expect(
      resolveStaleBundleReloadPair({ ...input, bundleVersion: "2026.7.10", gatewayVersion: "" }),
    ).toBeNull();
    expect(
      resolveStaleBundleReloadPair({
        ...input,
        bundleVersion: null,
        gatewayVersion: "2026.7.11",
      }),
    ).toBeNull();
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
    const reload = vi.fn();

    expect(
      reloadWithComposerGuard({
        root: reloadRoot(prepare),
        confirmDiscardAttachments: confirmDiscard,
        reload,
      }),
    ).toBe(true);
    expect(prepare).toHaveBeenCalledOnce();
    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("requires consent before discarding staged attachments", () => {
    const prepare = vi.fn(() => "attachments" as const);
    const confirmDiscard = vi.fn(() => false);
    const reload = vi.fn();

    expect(
      reloadWithComposerGuard({
        root: reloadRoot(prepare),
        confirmDiscardAttachments: confirmDiscard,
        reload,
      }),
    ).toBe(false);
    expect(prepare).toHaveBeenCalledOnce();
    expect(confirmDiscard).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not offer attachment discard when draft persistence is blocked", () => {
    const confirmDiscard = vi.fn(() => true);
    const reload = vi.fn();
    expect(
      reloadWithComposerGuard({
        root: reloadRoot(() => "blocked"),
        confirmDiscardAttachments: confirmDiscard,
        reload,
      }),
    ).toBe(false);
    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads safely when no composer is mounted", () => {
    const reload = vi.fn();
    expect(reloadWithComposerGuard({ root: reloadRoot(), reload })).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe("idle stale-bundle reload preparation", () => {
  it("uses the shared probe but blocks instead of prompting for attachments", () => {
    const prepare = vi.fn(() => "attachments" as const);
    expect(prepareComposerForIdleReload(reloadRoot(prepare))).toBe(false);
    expect(prepare).toHaveBeenCalledOnce();
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
    const controller = new StaleBundleReloadController({
      idleMs: TEST_IDLE_MS,
      prepareReload,
      reload,
      storage,
    });
    controllers.push(controller);
    return { controller, prepareReload, reload, storage };
  }

  it("reloads an idle background tab after preparing its composer draft", async () => {
    setDocumentActivityState("hidden", false);
    const { controller, prepareReload, reload } = createController();
    controller.update(VERSION_PAIR);

    await vi.advanceTimersByTimeAsync(TEST_IDLE_MS);

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
    await vi.advanceTimersByTimeAsync(TEST_IDLE_MS * 2);

    expect(prepareReload).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("never reloads a visible focused tab", async () => {
    setDocumentActivityState("visible", true);
    const { controller, prepareReload, reload } = createController();
    controller.update(VERSION_PAIR);

    await vi.advanceTimersByTimeAsync(TEST_IDLE_MS * 2);

    expect(prepareReload).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("resets the idle window on user activity", async () => {
    setDocumentActivityState("hidden", false);
    const { controller, reload } = createController();
    controller.update(VERSION_PAIR);
    await vi.advanceTimersByTimeAsync(TEST_IDLE_MS - 1_000);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reload).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TEST_IDLE_MS - 1_000);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does not reload when composer state cannot be persisted safely", async () => {
    setDocumentActivityState("hidden", false);
    const { controller, prepareReload, reload } = createController(vi.fn(() => false));
    controller.update(VERSION_PAIR);

    await vi.advanceTimersByTimeAsync(TEST_IDLE_MS);

    expect(prepareReload).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
  });

  it("tears down the idle timer when the mismatch disconnects", async () => {
    setDocumentActivityState("hidden", false);
    const { controller, prepareReload, reload } = createController();
    controller.update(VERSION_PAIR);
    controller.update(null);

    await vi.advanceTimersByTimeAsync(TEST_IDLE_MS);

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

    await vi.advanceTimersByTimeAsync(TEST_IDLE_MS);

    expect(first.reload).toHaveBeenCalledOnce();
    expect(storage.getItem(AUTO_RELOAD_STORAGE_KEY)).toBe(
      JSON.stringify([JSON.stringify([VERSION_PAIR.bundleVersion, VERSION_PAIR.gatewayVersion])]),
    );

    const secondPair = { ...VERSION_PAIR, gatewayVersion: "2026.7.12" };
    const interveningReload = createController(
      vi.fn(() => true),
      storage,
    );
    interveningReload.controller.update(secondPair);
    await vi.advanceTimersByTimeAsync(TEST_IDLE_MS);
    expect(interveningReload.reload).toHaveBeenCalledOnce();

    const repeatedFirstPair = createController(
      vi.fn(() => true),
      storage,
    );
    repeatedFirstPair.controller.update(VERSION_PAIR);
    await vi.advanceTimersByTimeAsync(TEST_IDLE_MS * 2);

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

    await vi.advanceTimersByTimeAsync(TEST_IDLE_MS);

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

    await vi.advanceTimersByTimeAsync(TEST_IDLE_MS);

    expect(reload).not.toHaveBeenCalled();
  });
});
