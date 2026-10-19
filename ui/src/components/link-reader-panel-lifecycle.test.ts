import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlUiLinkReaderDocument } from "../../../src/shared/control-ui-link-reader.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid as waitForFast } from "../test-helpers/solid-settle.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  itemUrl,
  reader,
  item,
  deferredDetail,
  mount,
  open,
  expectTitle,
} from "./link-reader-panel.test-support.ts";

describe("Link reader publication lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    // Section selection owns these requests; no viewport preload is admitted here.
    vi.stubGlobal(
      "IntersectionObserver",
      class extends IntersectionObserver {
        override observe() {}
      },
    );
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("coalesces replacement inputs and ignores old navigation and client responses", async () => {
    const first = deferredDetail();
    const second = deferredDetail();
    const request = vi
      .fn<
        (
          _method: string,
          _params?: unknown,
          options?: { signal?: AbortSignal },
        ) => Promise<ControlUiLinkReaderDocument>
      >()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const panel = await mount(request);
    open(panel);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(1));
    open(panel, itemUrl(2));
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    first.resolve(item(1));
    await panel.updateComplete;
    expect(panel.querySelector("h1")).toBeNull();
    const transient = vi.fn().mockResolvedValue({ ...item(2), title: "Transient gateway" });
    const replacement = vi.fn().mockResolvedValue({ ...item(2), title: "New gateway" });
    panel.client = { request: transient } as unknown as GatewayBrowserClient;
    panel.agentId = "transient-agent";
    panel.readers = [];
    panel.client = { request: replacement } as unknown as GatewayBrowserClient;
    panel.agentId = "current-agent";
    panel.readers = [reader];
    await expectTitle(panel, "New gateway");
    expect(transient).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledExactlyOnceWith(
      "forge.item",
      { url: itemUrl(2), agentId: "current-agent" },
      { signal: expect.any(AbortSignal) },
    );
    expect(request.mock.calls[1]?.[2]?.signal?.aborted).toBe(true);
    second.resolve(item(2));
    await panel.updateComplete;
    expect(panel.querySelector("h1")?.textContent).toBe("New gateway");
  });

  it("retires a pending render on removal and keeps the replacement view authoritative", async () => {
    const stale = deferredDetail();
    const request = vi
      .fn<
        (
          _method: string,
          _params?: unknown,
          options?: { signal?: AbortSignal },
        ) => Promise<ControlUiLinkReaderDocument>
      >()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue(item(2));
    const panel = await mount(request, { embedded: true, presented: true });
    open(panel);
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    panel.tabsInHeader = true;
    const pending = panel.updateComplete;
    panel.remove();
    await expect(pending).resolves.toBe(false);
    expect(request.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);

    mountSolid(() => panel);
    await panel.updateComplete;
    open(panel, itemUrl(2));
    await expectTitle(panel, "Item 2");
    stale.resolve(item(1));
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
