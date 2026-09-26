import { describe, expect, it } from "vitest";
import {
  createBrowserClient,
  createBrowserPanelTestMetrics,
  TestBrowserPanelHost,
} from "./browser-panel-controller-test-support.ts";
import { BrowserPanelOperationOwnership } from "./browser-panel-operation-ownership.ts";

describe("BrowserPanelOperationOwnership", () => {
  it("retires captured clients immediately when the session changes before rendering", async () => {
    const { client, request } = createBrowserClient(async () => ({}));
    const host = new TestBrowserPanelHost(client);
    host.sessionKey = "agent:main:first";
    const ownership = new BrowserPanelOperationOwnership(host);
    const first = ownership.captureClient()!;
    const pending = ownership.beginSnapshot(first);
    host.sessionKey = "agent:main:second";
    expect(pending.isCurrent()).toBe(false);
    await expect(
      first.request("browser.request", { method: "POST", path: "/tabs/open" }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled();
    const second = ownership.captureClient()!;
    await second.request("browser.request", { method: "GET", path: "/tabs" });
    expect(request).toHaveBeenCalledExactlyOnceWith("browser.request", {
      method: "GET",
      path: "/tabs",
      sessionKey: "agent:main:second",
    });
  });

  it("releases navigation commits when tabs reconcile, close, or leave an accepted snapshot", () => {
    const { client } = createBrowserClient(async () => ({}));
    const ownership = new BrowserPanelOperationOwnership(new TestBrowserPanelHost(client));
    ownership.markNavigationCommitted(client, "tab-a");
    ownership.markNavigationCommitted(client, "tab-b");

    ownership.retainTabSnapshot(client, [
      {
        kind: "remote" as const,
        id: "tab-a",
        targetId: "raw-a",
        title: "A",
        url: "https://a.example",
      },
    ]);
    expect(ownership.hasUnreconciledNavigation(client, "tab-a")).toBe(true);
    expect(ownership.hasUnreconciledNavigation(client, "tab-b")).toBe(false);

    ownership.forgetNavigation(client, "tab-a");
    expect(ownership.hasUnreconciledNavigation(client, "tab-a")).toBe(false);
  });

  it("reconciles captured metadata without replacing an unchanged tab list", () => {
    const { client } = createBrowserClient(async () => ({}));
    const ownership = new BrowserPanelOperationOwnership(new TestBrowserPanelHost(client));
    const tabs = [
      {
        kind: "remote" as const,
        id: "tab-a",
        targetId: "raw-a",
        title: "A",
        url: "https://a.example",
      },
    ];
    const metrics = createBrowserPanelTestMetrics("https://b.example", "B").result;

    const reconciled = ownership.capturedTabs(tabs, "tab-a", metrics, metrics.url);
    expect(reconciled).toEqual([
      {
        kind: "remote" as const,
        id: "tab-a",
        targetId: "raw-a",
        title: "B",
        url: "https://b.example",
      },
    ]);
    expect(ownership.capturedTabs(reconciled, "tab-a", metrics, metrics.url)).toBe(reconciled);
    expect(
      ownership.capturedTabs(
        [{ ...reconciled[0]!, urlUnavailableReason: "navigation_blocked" }],
        "tab-a",
        metrics,
        metrics.url,
      )[0]?.urlUnavailableReason,
    ).toBeUndefined();
  });
});
