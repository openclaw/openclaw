import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid as waitForFast } from "../test-helpers/solid-settle.ts";
import * as h from "./link-reader-panel.test-support.ts";

describe("Link reader publication lifecycle", () => {
  h.setupLinkReaderPanelTests();

  it("coalesces replacement inputs and ignores old navigation and client responses", async () => {
    const first = h.deferredDetail();
    const second = h.deferredDetail();
    const request = vi
      .fn<h.DetailRequest>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const panel = await h.mount(request);
    h.open(panel);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(1));
    h.open(panel, h.itemUrl(2));
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    first.resolve(h.item(1));
    await panel.updateComplete;
    expect(panel.querySelector("h1")).toBeNull();
    const transient = vi.fn().mockResolvedValue({ ...h.item(2), title: "Transient gateway" });
    const replacement = vi.fn().mockResolvedValue({ ...h.item(2), title: "New gateway" });
    panel.client = { request: transient } as unknown as GatewayBrowserClient;
    panel.agentId = "transient-agent";
    panel.readers = [];
    panel.client = { request: replacement } as unknown as GatewayBrowserClient;
    panel.agentId = "current-agent";
    panel.readers = [h.reader];
    await h.expectTitle(panel, "New gateway");
    expect(transient).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledExactlyOnceWith(
      "forge.item",
      { url: h.itemUrl(2), agentId: "current-agent" },
      { signal: expect.any(AbortSignal) },
    );
    expect(request.mock.calls[1]?.[2]?.signal?.aborted).toBe(true);
    second.resolve(h.item(2));
    await panel.updateComplete;
    expect(panel.querySelector("h1")?.textContent).toBe("New gateway");
  });

  it("retires a pending render on removal and keeps the replacement view authoritative", async () => {
    const stale = h.deferredDetail();
    const request = vi
      .fn<h.DetailRequest>()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue(h.item(2));
    const panel = await h.mount(request, { embedded: true, presented: true });
    h.open(panel);
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    panel.tabsInHeader = true;
    const pending = panel.updateComplete;
    panel.remove();
    await expect(pending).resolves.toBe(false);
    expect(request.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);

    mountSolid(() => panel);
    await panel.updateComplete;
    h.open(panel, h.itemUrl(2));
    await h.expectTitle(panel, "Item 2");
    stale.resolve(h.item(1));
    await stale.promise;
    await panel.updateComplete;
    expect(panel.querySelector("h1")?.textContent).toBe("Item 2");
    expect(panel.querySelector(".lr-tab-header")).toBeNull();

    panel.tabsInHeader = false;
    await panel.updateComplete;
    expect(panel.querySelector(".lr-tab-header")).not.toBeNull();
    await panel.closeHostedTab(panel.activeHostedTabId!);
    expect(panel.hostedTabs).toEqual([]);
    expect(panel.querySelector(".link-reader-panel")).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
