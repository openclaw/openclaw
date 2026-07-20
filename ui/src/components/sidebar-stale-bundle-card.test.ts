/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveStaleBundleReloadPair } from "../app/stale-bundle.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import "./sidebar-stale-bundle-card.ts";

// Mirrors the module-local key so persistence is tested without exporting internals.
const DISMISS_STORAGE_KEY = "openclaw:control-ui:stale-bundle-dismissed:v1";

type SidebarStaleBundleCardElement = HTMLElement & {
  gatewayVersion: string | null;
  onRefresh: () => void;
  updateComplete: Promise<unknown>;
};

async function mount(gatewayVersion: string | null) {
  const element = document.createElement(
    "openclaw-sidebar-stale-bundle-card",
  ) as SidebarStaleBundleCardElement;
  element.gatewayVersion = gatewayVersion;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

describe("SidebarStaleBundleCard", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: createStorageMock(),
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("shows the refresh nudge for a mismatched gateway version", async () => {
    const element = await mount("2026.7.11");
    expect(element.querySelector(".sidebar-stale-bundle")?.textContent).toContain(
      "Server updated — refresh for the latest features.",
    );
  });

  it("renders nothing without a mismatch version", async () => {
    const element = await mount(null);
    expect(element.querySelector(".sidebar-stale-bundle")).toBeNull();
  });

  it("shows only same-origin actionable mismatches", async () => {
    const input = {
      bundleVersion: "2026.7.10",
      gatewayVersion: "2026.7.11",
      documentHref: "https://team.openclaw.ai/chat",
    };
    const sameOrigin = resolveStaleBundleReloadPair({
      ...input,
      gatewayUrl: "wss://team.openclaw.ai/gateway",
    });
    const crossOrigin = resolveStaleBundleReloadPair({
      ...input,
      gatewayUrl: "wss://gateway.example.test",
    });

    const sameOriginCard = await mount(sameOrigin?.gatewayVersion ?? null);
    const crossOriginCard = await mount(crossOrigin?.gatewayVersion ?? null);
    expect(sameOriginCard.querySelector(".sidebar-stale-bundle")).not.toBeNull();
    expect(crossOriginCard.querySelector(".sidebar-stale-bundle")).toBeNull();
  });

  it("forwards the Refresh action", async () => {
    const element = await mount("2026.7.11");
    const onRefresh = vi.fn();
    element.onRefresh = onRefresh;
    await element.updateComplete;

    element.querySelector<HTMLButtonElement>(".sidebar-stale-bundle__refresh")?.click();
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("persists dismissal per gateway version and re-nudges after another upgrade", async () => {
    const element = await mount("2026.7.11");
    element.querySelector<HTMLButtonElement>(".sidebar-stale-bundle__dismiss")?.click();
    await element.updateComplete;

    expect(JSON.parse(localStorage.getItem(DISMISS_STORAGE_KEY) ?? "null")).toMatchObject({
      gatewayVersion: "2026.7.11",
    });
    expect(element.querySelector(".sidebar-stale-bundle")).toBeNull();

    const dismissedReplacement = await mount("2026.7.11");
    expect(dismissedReplacement.querySelector(".sidebar-stale-bundle")).toBeNull();
    const newerReplacement = await mount("2026.7.12");
    expect(newerReplacement.querySelector(".sidebar-stale-bundle")).not.toBeNull();
  });
});
