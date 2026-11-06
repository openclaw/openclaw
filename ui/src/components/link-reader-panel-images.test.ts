import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { waitForSolid as waitForFast } from "../test-helpers/solid-settle.ts";
import {
  item,
  itemUrl,
  reader,
  mount,
  open,
  expectTitle,
  setupLinkReaderPanelTests,
} from "./link-reader-panel.test-support.ts";

describe("Plugin link reader panel images", () => {
  setupLinkReaderPanelTests();
  it("resolves document images through the reader, deduplicates attachments, and preserves source links", async () => {
    const url = "https://images.example/attachment.png";
    const dataUrl = "data:image/png;base64,aW1hZ2U=";
    const request = vi.fn(async (method: string) =>
      method === "forge.image"
        ? { url, dataUrl }
        : {
            ...item(),
            body: `![Screenshot](${url})`,
            comments: [
              { id: "comment", url: itemUrl(1), author: "reviewer", body: `![Repeated](${url})` },
            ],
          },
    );
    const panel = await mount(request);
    panel.readers = [
      { ...reader, linkReader: { ...reader.linkReader, imageMethod: "forge.image" } },
    ];
    await panel.updateComplete;
    open(panel);
    await waitForFast(() =>
      expect([...panel.querySelectorAll("img")].map((image) => image.src)).toEqual([
        dataUrl,
        dataUrl,
      ]),
    );
    expect(request.mock.calls.filter(([method]) => method === "forge.image")).toHaveLength(1);
    expect(panel.querySelector<HTMLAnchorElement>(".lr-image a")?.href).toBe(url);
  });

  it("cancels retired document image requests and ignores late results after a connection replacement", async () => {
    const url = "https://images.example/pending.png";
    let finish!: (value: unknown) => void;
    let imageSignal: AbortSignal | undefined;
    const request = vi.fn(
      async (method: string, _params?: unknown, options?: { signal?: AbortSignal }) => {
        if (method === "forge.image") {
          imageSignal = options?.signal;
          return new Promise((resolve) => {
            finish = resolve;
          });
        }
        return { ...item(), body: `![Pending](${url})` };
      },
    );
    const panel = await mount(request);
    panel.readers = [
      { ...reader, linkReader: { ...reader.linkReader, imageMethod: "forge.image" } },
    ];
    await panel.updateComplete;
    open(panel);
    await waitForFast(() => expect(imageSignal).toBeDefined());
    const oldImage = panel.querySelector("img")!;
    expect(oldImage.hasAttribute("src")).toBe(false);
    panel.client = {
      request: vi.fn().mockResolvedValue(item()),
    } as unknown as GatewayBrowserClient;
    await panel.updateComplete;
    expect(imageSignal?.aborted).toBe(true);
    finish({ url, dataUrl: "data:image/png;base64,aW1hZ2U=" });
    await expectTitle(panel, "Item 1");
    expect(oldImage.hasAttribute("src")).toBe(false);
    expect(panel.querySelector("img")).toBeNull();
  });

  it("bounds image fanout and cancels queued work when its tab is removed", async () => {
    const signals: AbortSignal[] = [];
    const panel = await mount(async (method, _params, options) => {
      if (method !== "forge.image") {
        return {
          ...item(),
          body: Array.from(
            { length: 40 },
            (_, i) => `![Image ${i}](https://images.example/${i}.png)`,
          ).join("\n\n"),
        };
      }
      const signal = options!.signal!;
      signals.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    panel.readers = [
      { ...reader, linkReader: { ...reader.linkReader, imageMethod: "forge.image" } },
    ];
    await panel.updateComplete;
    open(panel);
    await waitForFast(() => expect(signals).toHaveLength(4));
    await panel.closeHostedTab(panel.activeHostedTabId!);
    await waitForFast(() => expect(signals.every((signal) => signal.aborted)).toBe(true));
    expect(signals).toHaveLength(4);
  });

  it.each([
    { url: "https://images.example/wrong.png", dataUrl: "data:image/png;base64,aW1hZ2U=" },
    { url: "https://images.example/image.png", dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" },
    { url: "https://images.example/image.png", dataUrl: "https://images.example/credentialed.png" },
  ])(
    "falls back only to the original anonymous image URL after an invalid response: $dataUrl",
    async (response) => {
      const url = "https://images.example/image.png";
      const panel = await mount(
        vi.fn(async (method) =>
          method === "forge.image" ? response : { ...item(), body: `![Screenshot](${url})` },
        ),
      );
      panel.readers = [
        { ...reader, linkReader: { ...reader.linkReader, imageMethod: "forge.image" } },
      ];
      await panel.updateComplete;
      open(panel);
      await waitForFast(() => expect(panel.querySelector("img")?.src).toBe(url));
      expect(panel.querySelector("img")?.crossOrigin).toBe("anonymous");
      expect(panel.querySelector<HTMLAnchorElement>(".lr-image a")?.href).toBe(url);
    },
  );
});
