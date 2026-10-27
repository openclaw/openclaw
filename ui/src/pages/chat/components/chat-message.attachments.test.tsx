/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { mediaTicketPayload } from "../../../test-helpers/control-ui-attachment-fixtures.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  requireFetchCallForUrl,
  expectSameOriginGet,
  stubObjectUrls,
  rejectWhenAborted,
  flushAttachmentChecks,
  advanceAttachments,
  stubFetch,
  nativeAudio,
  attachmentDownload,
} from "./chat-message-attachments.test-support.ts";
import { managedSource } from "./chat-message-media.test-helpers.ts";
import {
  createChatMessageHarness,
  type RenderMessageGroupOptions,
} from "./chat-message-render.test-support.tsx";
import {
  createAssistantMessage,
  createAttachmentBlock,
  createUserMessage,
  createMediaBlock,
  createAssistantImageMessage,
} from "./chat-message.test-support.ts";

const harness = createChatMessageHarness();
const {
  requireElement,
  element,
  elements,
  elementText,
  expectCount,
  expectAbsent,
  renderAssistantMessage,
  renderGroupedMessage,
} = harness;
const audio = (root: Element = harness.view) => root.querySelector("openclaw-chat-audio-player");
const downloadHref = (root: Element) => attachmentDownload(root)?.getAttribute("href");

describe("grouped chat attachments", () => {
  function renderReactiveAssistant(
    message: () => unknown,
    options: Partial<RenderMessageGroupOptions> = {},
    container: HTMLElement = harness.view,
  ) {
    const rerender = () =>
      renderAssistantMessage(
        message(),
        { showToolCalls: false, ...options, mediaOwner: rerender },
        container,
      );
    rerender();
  }

  function mountManagedAudio(
    source: string,
    artifactId: string,
    resolveArtifactDownload: RenderMessageGroupOptions["resolveArtifactDownload"],
  ) {
    const container = document.body.appendChild(document.createElement("div"));
    renderReactiveAssistant(
      () => nativeAudio(source, artifactId),
      { resolveArtifactDownload },
      container,
    );
    return container;
  }

  it("omits the reply strip when reply-to-current has no source", () => {
    renderAssistantMessage(
      createAssistantMessage("Reply", {
        openclawDelivery: { replyToCurrent: true },
      }),
    );
    expectAbsent(".chat-reply-attribution");
  });

  function managedTicketFixture() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    const source = managedSource();
    const artifactId = `artifact_managed_media_${crypto.randomUUID()}`;
    return {
      source,
      artifactId,
      ticket: (name: string, ttl: number) => ({
        url: `${source}?mediaTicket=${name}`,
        expiresAt: new Date(Date.now() + ttl).toISOString(),
      }),
    };
  }

  function expectManagedAudio(container: Element, blocked: boolean) {
    expect(container.querySelector(".chat-assistant-attachment-card--blocked") !== null).toBe(
      blocked,
    );
  }

  it("backs off stale managed ticket refreshes and eventually marks them unavailable", async () => {
    const { source, artifactId, ticket } = managedTicketFixture();
    let finishSecondRequest: (() => void) | undefined;
    const resolveArtifactDownload = vi.fn(() => {
      const requestNumber = resolveArtifactDownload.mock.calls.length;
      const result = ticket(`stale-${requestNumber}`, requestNumber === 1 ? 6_000 : -1_000);
      if (requestNumber !== 2) {
        return Promise.resolve(result);
      }
      return new Promise<typeof result>((resolve) => {
        finishSecondRequest = () => resolve(result);
      });
    });
    const container = mountManagedAudio(source, artifactId, resolveArtifactDownload);
    await vi.dynamicImportSettled();
    await waitForSolid(() => expect(audio(container)).not.toBeNull(), { interval: 0 });
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(1);
    await advanceAttachments(1);
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
    expect(audio(container)).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
    expectManagedAudio(container, true);
    finishSecondRequest?.();
    await flushAttachmentChecks();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
    await advanceAttachments(1);

    expect(resolveArtifactDownload).toHaveBeenCalledTimes(3);
    expectManagedAudio(container, true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["unchanged expiry", false, 2, 4_999, 1],
    ["longer-lived recovery after a failed refresh", true, 3, 5_000, 15_000],
  ] as const)(
    "retains a managed ticket through refresh exhaustion with %s",
    async (_label, refreshFails, retainedTicket, beforeExpiry, untilExpiry) => {
      const { source, artifactId, ticket } = managedTicketFixture();
      const initialExpiry = Date.now() + 20_000;
      const resolveArtifactDownload = vi.fn(async () => {
        const attempt = resolveArtifactDownload.mock.calls.length;
        if (refreshFails && attempt === 2) {
          throw new Error("refresh unavailable");
        }
        return ticket(
          `short-${attempt}`,
          refreshFails && attempt === 3 ? 20_000 : initialExpiry - Date.now(),
        );
      });
      const container = mountManagedAudio(source, artifactId, resolveArtifactDownload);
      await vi.dynamicImportSettled();
      await waitForSolid(() => expect(audio(container)).not.toBeNull(), { interval: 0 });
      await advanceAttachments(5_000);
      if (refreshFails) {
        expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
        expectManagedAudio(container, false);
        expect(downloadHref(container)).toContain("mediaTicket=short-1");
      }
      await advanceAttachments(10_000);
      expect(resolveArtifactDownload).toHaveBeenCalledTimes(3);
      expect(downloadHref(container)).toContain(`mediaTicket=short-${retainedTicket}`);
      expectManagedAudio(container, false);
      await advanceAttachments(beforeExpiry);
      expect(audio(container)).not.toBeNull();
      await advanceAttachments(untilExpiry);
      expect(resolveArtifactDownload).toHaveBeenCalledTimes(3);
      expectManagedAudio(container, true);
    },
  );

  it("does not render an unticketed managed attachment without an artifact resolver", async () => {
    const source = managedSource();
    renderAssistantMessage(nativeAudio(source, `artifact_managed_media_${crypto.randomUUID()}`), {
      showToolCalls: false,
    });

    await vi.dynamicImportSettled();
    await waitForSolid(() =>
      expect(elementText(".chat-assistant-attachment-card--blocked")).toContain("Unavailable"),
    );
    expectAbsent("openclaw-chat-audio-player");
  });

  it("keeps server-rejected outside-allowed-folders media blocked", async () => {
    const code = "outside-allowed-folders";
    const reason = "Outside allowed folders";
    const source = "/home/node/private/bootstrap-secret.mp3";
    const fetchMock = stubFetch(async (url: string, init?: RequestInit) => {
      expect(url).toContain("meta=1");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer session-token");
      return { ok: true, json: async () => ({ available: false, code, reason }) };
    });

    renderReactiveAssistant(
      () => createAssistantMessage(`Unavailable recording\nMEDIA:${source}`),
      {
        resourceBasePath: "/openclaw",
        assistantAttachmentAuthToken: "session-token",
      },
    );

    await vi.dynamicImportSettled();
    await waitForSolid(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flushAttachmentChecks();

    await vi.waitFor(() =>
      expect(
        elementText(
          ".chat-assistant-attachment-card--blocked .chat-assistant-attachment-card__status-meta",
        ),
      ).toContain(reason),
    );
    expectAbsent("audio");
    expect(attachmentDownload(harness.view)).toBeNull();
  });

  it("stops checking when local assistant attachment metadata fetch stalls", async () => {
    vi.useFakeTimers();
    const source = `/tmp/openclaw/${crypto.randomUUID()}-stalled.txt`;
    const fetchMock = stubFetch((_url: string, init?: RequestInit) => {
      const signal = expectDefined(init?.signal, "attachment request signal");
      return rejectWhenAborted<Response>(signal, () =>
        signal.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError"),
      );
    });
    renderReactiveAssistant(() => createAssistantMessage(`Local document\nMEDIA:${source}`), {
      resourceBasePath: "/openclaw",
    });

    const card = requireElement(".chat-assistant-attachment-card--compact", HTMLElement);
    const download = requireElement("a[download]", HTMLAnchorElement, card);
    expect(card.textContent).toContain(source.split("/").at(-1));
    expect(card.querySelector(".skeleton")).toBeNull();
    expect([
      download.getAttribute("href"),
      download.getAttribute("aria-disabled"),
      download.tabIndex,
    ]).toEqual([null, "true", 0]);

    const expectedMetaUrl = `/openclaw/__openclaw__/assistant-media?source=${encodeURIComponent(source)}&meta=1`;
    await vi.advanceTimersByTimeAsync(0);
    const [, fetchInit] = requireFetchCallForUrl(fetchMock, expectedMetaUrl);
    await advanceAttachments(30_001);

    expect(fetchInit?.signal).toMatchObject({ aborted: true });
    expect(fetchInit?.signal).toBeInstanceOf(AbortSignal);
    expect(elementText(".chat-assistant-attachment-card__status-meta")).toContain("Unavailable");
    expectAbsent(".chat-assistant-attachment-card__action-skeleton");
  });

  it("refreshes a managed attachment ticket while its Files player stays open", async () => {
    const { source, artifactId, ticket } = managedTicketFixture();
    const first = ticket("first", 31_000);
    const refreshed = ticket("refreshed", 5 * 60_000);
    const resolveArtifactDownload = vi
      .fn<() => Promise<{ url: string; expiresAt: string }>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(refreshed);
    const container = document.body.appendChild(document.createElement("div"));
    let sidebarContent: unknown;
    renderReactiveAssistant(
      () =>
        createAssistantMessage([
          createAttachmentBlock(source, "audio", "clip.mp3", "audio/mpeg", { artifactId }),
        ]),
      {
        resolveArtifactDownload,
        onOpenSidebar: (content) => {
          sidebarContent = content;
        },
      },
      container,
    );

    await flushAttachmentChecks();
    requireElement(".chat-assistant-attachment-card__expand", HTMLButtonElement, container).click();
    expect(sidebarContent).not.toHaveProperty("src");
    expect(sidebarContent).toHaveProperty("sourceIdentity", source);

    const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: unknown;
      attachmentRuntime: unknown;
      updateComplete: Promise<unknown>;
    };
    panel.content = sidebarContent;
    panel.attachmentRuntime = { resolveArtifactDownload };
    document.body.append(panel);
    await panel.updateComplete;
    expect(panel.querySelector("audio")?.getAttribute("src")).toBe(first.url);

    await advanceAttachments(1_000);
    await panel.updateComplete;

    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
    expect(panel.querySelector("audio")?.getAttribute("src")).toBe(refreshed.url);
    panel.remove();
    container.remove();
  });
});

describe("grouped chat images", () => {
  const imageElement = (root: Element = harness.view) =>
    root.querySelector<HTMLImageElement>(".chat-message-image");
  const thumbnail = (source: string) => `${source.replace(/\/full$/u, "/thumbnail")}?v=4&width=480`;
  const dimensions = { width: 1, height: 1 };

  function mountAssistantImage(
    url: string,
    alt: string,
    options: Partial<RenderMessageGroupOptions> = {},
  ) {
    const container = document.createElement("div");
    renderAssistantMessage(createAssistantImageMessage(url, alt), options, container);
    return container;
  }

  function renderImageBatch(
    urls: string[],
    label: string,
    options: Partial<RenderMessageGroupOptions> = {},
  ) {
    renderAssistantMessage(
      createAssistantMessage(
        urls.map((url, index) => createMediaBlock({ url, alt: `${label} ${index + 1}` })),
      ),
      options,
    );
  }

  it("renders transcript image variants with their message identity and structured image blocks", async () => {
    const firstSource = `/tmp/openclaw/${crypto.randomUUID()}-first.png`;
    const secondSource = `/tmp/openclaw/${crypto.randomUUID()}-second.jpg`;
    const requested: (string | null)[][] = [];
    stubFetch(async (url: string, init?: RequestInit) => {
      const mediaUrl = new URL(url, "http://control.test");
      expect(mediaUrl.pathname).toBe("/openclaw/__openclaw__/assistant-media");
      expect(mediaUrl.searchParams.get("meta")).toBe("1");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-auth-token");
      requested.push([mediaUrl.searchParams.get("source"), mediaUrl.searchParams.get("messageId")]);
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
    const displayed = () =>
      elements<HTMLImageElement>(".chat-message-image").map((image) => {
        const params = new URL(image.src).searchParams;
        return [params.get("source"), params.get("messageId"), params.get("sessionKey")];
      });
    const expected = (source: string, id: string) => [source, id, "agent:main:transcript-images"];
    renderUserMedia("saved-image-octet-stream", [
      { path: firstSource, contentType: "application/octet-stream" },
    ]);
    await waitForSolid(() =>
      expect(displayed()).toEqual([expected(firstSource, "saved-image-octet-stream")]),
    );

    renderUserMedia("saved-image-pair", [
      { path: firstSource, contentType: "image/png" },
      { path: secondSource, contentType: "application/octet-stream" },
    ]);
    await waitForSolid(() =>
      expect(displayed()).toEqual([
        expected(firstSource, "saved-image-pair"),
        expected(secondSource, "saved-image-pair"),
      ]),
    );
    expect(requested).toEqual([
      [firstSource, "saved-image-octet-stream"],
      [firstSource, "saved-image-pair"],
      [secondSource, "saved-image-pair"],
    ]);

    renderAssistantMessage(
      createAssistantMessage([{ type: "input_image", image_url: "data:image/png;base64,cG5n" }]),
    );
    expect(imageElement()?.getAttribute("src")).toBe("data:image/png;base64,cG5n");
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

    const image = imageElement();
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
      createAssistantImageMessage(source, "Generated image body stall", dimensions),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, fetchInit] = requireFetchCallForUrl(fetchMock, thumbnail(source));
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
    const options = {
      assistantAttachmentAuthToken: "test-auth-token",
      resourceBasePath: "/rosita",
    };
    const expectedUrls = imageUrls.map((source) => `/rosita${thumbnail(source)}`);
    let objectUrlIndex = 0;
    const { createObjectURL, revokeObjectURL } = stubObjectUrls(
      () => `blob:managed-image-${objectUrlIndex++}`,
    );
    let deferEvictedRefetch = false;
    let resolveEvictedRefetch:
      | ((response: { ok: boolean; blob: () => Promise<Blob> }) => void)
      | undefined;
    const response = { ok: true, blob: async () => new Blob(["png"], { type: "image/png" }) };
    stubFetch((url: string, init?: RequestInit) => {
      expectSameOriginGet(init);
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer test-auth-token");
      expect(headers.get("x-openclaw-requester-session-key")).toBe("agent:main:main");
      expect(expectedUrls).toContain(url);
      if (deferEvictedRefetch && url === `/rosita${thumbnail(imageUrls[1]!)}`) {
        return new Promise<typeof response>((resolve) => {
          resolveEvictedRefetch = resolve;
        });
      }
      return Promise.resolve(response);
    });

    renderImageBatch(imageUrls.slice(0, 64), "Generated image", options);
    await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(64));

    mountAssistantImage(imageUrls[0]!, "Recently viewed image", options);
    expect(createObjectURL).toHaveBeenCalledTimes(64);

    const createsBeforeOverflow = createObjectURL.mock.calls.length;
    mountAssistantImage(imageUrls[64]!, "Newest image", options);
    await vi.waitFor(() =>
      expect(createObjectURL.mock.calls.length).toBeGreaterThan(createsBeforeOverflow),
    );
    expect(revokeObjectURL).toHaveBeenCalled();

    deferEvictedRefetch = true;
    const evictedContainer = mountAssistantImage(imageUrls[1]!, "Refetched image", options);
    await vi.waitFor(() => expect(resolveEvictedRefetch).toBeTypeOf("function"));

    const createsBeforeRefetch = createObjectURL.mock.calls.length;
    resolveEvictedRefetch?.(response);
    await vi.waitFor(() =>
      expect(createObjectURL.mock.calls.length).toBeGreaterThan(createsBeforeRefetch),
    );
    expect(imageElement(evictedContainer)).not.toBeNull();
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
