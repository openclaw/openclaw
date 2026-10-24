/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  requireFetchCallForUrl,
  expectSameOriginGet,
  rejectWhenAborted,
  flushAttachmentChecks,
  mediaTicketPayload,
  stubFetch,
  stubObjectUrls,
} from "./chat-message-attachments.test-support.ts";
import { managedSource } from "./chat-message-media.test-helpers.ts";
import { createChatMessageHarness } from "./chat-message-render.test-support.tsx";
import {
  createAssistantMessage,
  createUserMessage,
  createMediaBlock,
  createAssistantImageMessage,
} from "./chat-message.test-support.ts";

const harness = createChatMessageHarness();
const {
  requireElement,
  element,
  elements,
  expectCount,
  expectAbsent,
  renderAssistantMessage,
  renderGroupedMessage,
} = harness;

describe("grouped chat rendering", () => {
  function mountAssistantImage(url: string, alt: string) {
    const container = document.createElement("div");
    renderAssistantMessage(createAssistantImageMessage(url, alt), {}, container);
    return container;
  }

  function renderImageBatch(urls: string[], label: string) {
    renderAssistantMessage(
      createAssistantMessage(
        urls.map((url, index) => createMediaBlock({ url, alt: `${label} ${index + 1}` })),
      ),
    );
  }

  it("renders transcript image variants with their message identity and structured image blocks", async () => {
    const firstSource = `/tmp/openclaw/${crypto.randomUUID()}-first.png`;
    const secondSource = `/tmp/openclaw/${crypto.randomUUID()}-second.jpg`;
    const fetchMock = stubFetch(async (url: string, init?: RequestInit) => {
      const mediaUrl = new URL(url, "http://control.test");
      expect(mediaUrl.pathname).toBe("/openclaw/__openclaw__/assistant-media");
      expect(mediaUrl.searchParams.get("meta")).toBe("1");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-auth-token");
      return { ok: true, json: async () => mediaTicketPayload("ticket-transcript") };
    });

    const renderUserMedia = (id: string, media: { path: string; contentType: string }[]) => {
      const rerender = () =>
        renderGroupedMessage(createUserMessage("", { __openclaw: { id, media } }), "user", {
          showToolCalls: false,
          sessionKey: "agent:main:transcript-images",
          resourceBasePath: "/openclaw",
          assistantAttachmentAuthToken: "test-auth-token",
          mediaOwner: rerender,
        });
      rerender();
    };

    renderUserMedia("saved-image-octet-stream", [
      { path: firstSource, contentType: "application/octet-stream" },
    ]);
    await waitForSolid(() =>
      expect(
        harness.view.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
      ).toContain(`source=${encodeURIComponent(firstSource)}`),
    );
    const firstImageUrl = new URL(
      harness.view.querySelector<HTMLImageElement>(".chat-message-image")!.src,
    );
    expect([
      firstImageUrl.searchParams.get("messageId"),
      firstImageUrl.searchParams.get("sessionKey"),
    ]).toEqual(["saved-image-octet-stream", "agent:main:transcript-images"]);

    renderUserMedia("saved-image-pair", [
      { path: firstSource, contentType: "image/png" },
      { path: secondSource, contentType: "application/octet-stream" },
    ]);
    await waitForSolid(() =>
      expect(
        elements<HTMLImageElement>(".chat-message-image").map((image) => image.getAttribute("src")),
      ).toEqual([
        expect.stringContaining(`source=${encodeURIComponent(firstSource)}`),
        expect.stringContaining(`source=${encodeURIComponent(secondSource)}`),
      ]),
    );
    expect(
      elements<HTMLImageElement>(".chat-message-image").map((image) =>
        new URL(image.src).searchParams.get("messageId"),
      ),
    ).toEqual(["saved-image-pair", "saved-image-pair"]);
    expect(
      fetchMock.mock.calls.map(([url]) => {
        const params = new URL(url, "http://control.test").searchParams;
        return [params.get("source"), params.get("messageId")];
      }),
    ).toEqual([
      [firstSource, "saved-image-octet-stream"],
      [firstSource, "saved-image-pair"],
      [secondSource, "saved-image-pair"],
    ]);

    renderAssistantMessage(
      createAssistantMessage([{ type: "input_image", image_url: "data:image/png;base64,cG5n" }]),
    );
    expect(
      harness.view.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
    ).toBe("data:image/png;base64,cG5n");
  });

  it("expires pairing QR images without requesting a pane refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T05:45:00Z"));

    const renderQr = (data: string, ttl: number) =>
      renderAssistantMessage(
        createAssistantMessage([
          {
            type: "openclaw_pairing_qr",
            image_url: `data:image/png;base64,${data}`,
            alt: "OpenClaw pairing QR code",
            expiresAtMs: Date.now() + ttl,
          },
        ]),
        { showToolCalls: false },
      );
    renderQr("cXJwbmc=", 1_000);

    const image = harness.view.querySelector<HTMLImageElement>(".chat-message-image");
    expect(image).toMatchObject({
      src: "data:image/png;base64,cXJwbmc=",
      alt: "OpenClaw pairing QR code",
    });
    const bubble = element(".chat-bubble");
    expect(bubble).not.toBeNull();
    await vi.advanceTimersByTimeAsync(999);
    expect(element(".chat-message-image")).toBe(image);
    await vi.advanceTimersByTimeAsync(1);
    expect(element(".chat-bubble")).toBe(bubble);
    expectAbsent(".chat-message-image");
    expect(harness.view.textContent).toContain("Pairing QR expired");

    renderQr("ZXhwaXJlZA==", -1);
    expectAbsent(".chat-message-image");
    expect(harness.view.textContent).toContain("Pairing QR expired");
  });

  it.each([
    "media://inbound/nested%2Fphoto.png",
    "media://inbound/%00.png",
    "media://inbound/nested/../photo.png",
    "media://inbound/..",
  ])("does not proxy non-canonical inbound media ref %s", (source) => {
    const fetchMock = stubFetch();

    renderGroupedMessage(
      createUserMessage("", {
        __openclaw: { media: [{ path: source, contentType: "image/png" }] },
      }),
      "user",
      {
        showToolCalls: false,
        assistantAttachmentAuthToken: "session-token",
      },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("fetches managed outgoing chat images with auth and requester scope", async () => {
    const managedChatImageUrl = managedSource();
    const objectUrl = "blob:managed-image";
    stubObjectUrls(() => objectUrl);
    const fetchMock = stubFetch(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer test-auth-token");
      expect(headers.get("x-openclaw-requester-session-key")).toBe("agent:main:main");
      return { ok: true, blob: async () => new Blob(["png"], { type: "image/png" }) };
    });

    const onOpenImage = vi.fn();
    renderAssistantMessage(
      createAssistantImageMessage(managedChatImageUrl, "Generated image 1", {
        width: 1,
        height: 1,
      }),
      {
        showToolCalls: false,
        assistantAttachmentAuthToken: "test-auth-token",
        resourceBasePath: "/rosita",
        onOpenImage,
      },
    );

    await vi.waitFor(() => {
      expect(element(".chat-message-image")).toMatchObject({
        src: objectUrl,
        alt: "Generated image 1",
      });
    });
    const thumbnailUrl = `/rosita${managedChatImageUrl.replace(/\/full$/u, "/thumbnail")}?v=4&width=480`;
    const [, fetchInit] = requireFetchCallForUrl(fetchMock, thumbnailUrl);
    expectSameOriginGet(fetchInit);
    requireElement(".chat-message-image-button", HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(onOpenImage).toHaveBeenCalledWith(
        expect.objectContaining({ src: objectUrl, title: "Generated image 1" }),
      ),
    );
    const activeItem = onOpenImage.mock.calls[0]?.[0];
    activeItem?.release?.();
  });

  it("downloads a managed image from its pure-image actions", async () => {
    const artifactId = `artifact_managed_image_${crypto.randomUUID()}`;
    const source = managedSource();
    const ticketedUrl = `${source}?mediaTicket=ticket`;
    const thumbnailUrl = `${ticketedUrl.replace(/\/full(?=\?)/u, "/thumbnail")}&v=4&width=480`;
    const resolveArtifactDownload = vi.fn(async () => ({ url: ticketedUrl }));
    const objectUrls = ["blob:thumbnail", "blob:full", "blob:download"];
    const { revokeObjectURL } = stubObjectUrls(() => objectUrls.shift() ?? "blob:extra");
    const imageBlob = new Blob(["png"], { type: "image/png" });
    const fetchMock = stubFetch(async (_url: string | URL | Request, _init?: RequestInit) => ({
      ok: true,
      blob: async () => imageBlob,
    }));
    const clickedDownloads: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clickedDownloads.push(this.download);
    });
    const container = document.body.appendChild(document.createElement("div"));
    renderAssistantMessage(
      createAssistantImageMessage(source, "Ticketed image", { artifactId }),
      { showToolCalls: false, resolveArtifactDownload },
      container,
    );
    await vi.waitFor(() => expect(container.querySelector(".chat-message-image")).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(thumbnailUrl, expect.anything());

    // Own the delayed download cleanup before restoring the URL globals.
    vi.useFakeTimers();
    requireElement(
      '.chat-image-actions button[aria-label="Download image"]',
      HTMLButtonElement,
      container,
    ).click();
    await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(clickedDownloads[0]).toBe("Ticketed image.png");

    expect(fetchMock.mock.calls.filter((call: unknown[]) => call[0] === ticketedUrl)).toHaveLength(
      1,
    );
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:download");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:download");
    container.remove();
  });

  it("falls back when a managed outgoing image body stalls after headers", async () => {
    vi.useFakeTimers();
    const source = managedSource();
    const fetchMock = stubFetch(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("missing managed image signal");
      }
      return {
        ok: true,
        blob: async () =>
          await rejectWhenAborted<Blob>(
            signal,
            () => new DOMException("The operation was aborted.", "AbortError"),
          ),
      };
    });

    renderAssistantMessage(
      createAssistantImageMessage(source, "Generated image body stall", {
        width: 1,
        height: 1,
      }),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, fetchInit] = requireFetchCallForUrl(
      fetchMock,
      `${source.replace(/\/full$/u, "/thumbnail")}?v=4&width=480`,
    );
    expect(fetchInit?.signal?.aborted).toBe(false);
    expectSameOriginGet(fetchInit);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchInit?.signal?.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    expectAbsent(".chat-message-image");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds managed outgoing image blob URLs with least-recently-used eviction", async () => {
    const imageUrls = Array.from({ length: 65 }, () => managedSource());
    let objectUrlIndex = 0;
    const { createObjectURL, revokeObjectURL } = stubObjectUrls(
      () => `blob:managed-image-${objectUrlIndex++}`,
    );
    let deferEvictedRefetch = false;
    let resolveEvictedRefetch:
      | ((response: { ok: boolean; blob: () => Promise<Blob> }) => void)
      | undefined;
    const response = { ok: true, blob: async () => new Blob(["png"], { type: "image/png" }) };
    stubFetch((url: string) => {
      if (
        deferEvictedRefetch &&
        url === `${imageUrls[1]?.replace(/\/full$/u, "/thumbnail")}?v=4&width=480`
      ) {
        return new Promise<typeof response>((resolve) => {
          resolveEvictedRefetch = resolve;
        });
      }
      return Promise.resolve(response);
    });

    renderImageBatch(imageUrls.slice(0, 64), "Generated image");
    await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(64));

    mountAssistantImage(imageUrls[0]!, "Recently viewed image");
    expect(createObjectURL).toHaveBeenCalledTimes(64);

    const createsBeforeOverflow = createObjectURL.mock.calls.length;
    mountAssistantImage(imageUrls[64]!, "Newest image");
    await vi.waitFor(() =>
      expect(createObjectURL.mock.calls.length).toBeGreaterThan(createsBeforeOverflow),
    );
    expect(revokeObjectURL).toHaveBeenCalled();

    deferEvictedRefetch = true;
    const evictedContainer = mountAssistantImage(imageUrls[1]!, "Refetched image");
    await vi.waitFor(() => expect(resolveEvictedRefetch).toBeTypeOf("function"));

    const createsBeforeRefetch = createObjectURL.mock.calls.length;
    resolveEvictedRefetch?.(response);
    await vi.waitFor(() =>
      expect(createObjectURL.mock.calls.length).toBeGreaterThan(createsBeforeRefetch),
    );
    expect(evictedContainer.querySelector(".chat-message-image")).not.toBeNull();
  });

  it("bounds managed outgoing image miss retention", async () => {
    const imageUrls = Array.from({ length: 65 }, () => managedSource());
    const fetchMock = stubFetch(async () => ({ ok: false }));

    renderImageBatch(imageUrls.slice(0, 64), "Missing image");
    await waitForSolid(() => expectCount(".chat-image-frame--compact", 64));
    const overflowContainer = mountAssistantImage(imageUrls[64]!, "Newest missing image");
    await waitForSolid(() =>
      expect(overflowContainer.querySelector(".chat-image-frame--compact")).not.toBeNull(),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(imageUrls.length));
    await flushAttachmentChecks();

    mountAssistantImage(imageUrls[0]!, "Oldest missing image");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(imageUrls.length + 1));
  });

  it("does not send auth to cross-origin managed-image-looking URLs", async () => {
    const source =
      "https://evil.example/api/chat/media/outgoing/agent%3Amain%3Amain/00000000-0000-4000-8000-000000000000/full";
    const fetchMock = stubFetch(async () => {
      throw new Error("cross-origin image URL should not be fetched with Control UI auth");
    });

    renderAssistantMessage(createAssistantImageMessage(source, "Untrusted image"), {
      showToolCalls: false,
      assistantAttachmentAuthToken: "session-token",
    });

    await waitForSolid(() =>
      expect(element(".chat-message-image")?.getAttribute("src")).toBe(source),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens only safe assistant image URLs in the lightbox", async () => {
    const onOpenImage = vi.fn();
    for (const [url, safe] of [
      ["https://example.com/cat.png", true],
      ["javascript:alert(1)", false],
      ["data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' />", false],
    ] as const) {
      onOpenImage.mockClear();
      renderAssistantMessage(createAssistantMessage([{ type: "image_url", image_url: { url } }]), {
        onOpenImage,
      });
      await waitForSolid(() =>
        expect(element(".chat-message-image")).toBeInstanceOf(HTMLImageElement),
      );
      requireElement(".chat-message-image", HTMLImageElement).dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      if (safe) {
        expect(onOpenImage).toHaveBeenCalledWith(
          expect.objectContaining({ src: url, title: "Image" }),
        );
      } else {
        expect(onOpenImage).not.toHaveBeenCalled();
      }
    }
  });
});
