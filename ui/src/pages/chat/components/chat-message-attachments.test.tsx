/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createMemo } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeAttachmentContentBlock } from "../../../lib/chat/message-normalizer-attachments.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { AssistantAttachments } from "./chat-message-attachments-solid.tsx";
import { MessageImages } from "./chat-message-images-solid.tsx";
import { stubObjectUrls, ticketResponse } from "./chat-message-media.test-helpers.ts";
import {
  projectMessageMedia,
  releaseChatMediaResourceOwner,
  type AttachmentItem,
  type AssistantAttachmentItem,
} from "./chat-message-media.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

type AttachmentSidebarContent = Extract<SidebarContent, { kind: "attachment" }>;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.body.appendChild(document.createElement("div"));
});

function makeAttachment(
  url: string,
  label: string,
  mimeType?: string,
  overrides: Partial<AttachmentItem["attachment"]> = {},
): AttachmentItem {
  return {
    type: "attachment",
    attachment: { kind: "document", label, mimeType, url, ...overrides },
  };
}

const card = (part: string) => container.querySelector(`.chat-assistant-attachment-card${part}`);
const imageNode = () => container.querySelector("img.chat-message-image");
const action = (name: string) =>
  container.querySelector<HTMLButtonElement>(`.chat-assistant-attachment-card__${name}`);
const expandCard = () => action("expand")?.click();
const imageButton = () => container.querySelector<HTMLButtonElement>(".chat-message-image-button");
const svgElement = () => container.querySelector("openclaw-chat-svg-attachment");
const text = (part: string) => card(part)?.textContent;
const attr = (part: string, name: string) => card(part)?.getAttribute(name);

type AttachmentTestProps = Omit<Parameters<typeof AssistantAttachments>[0], "attachments"> & {
  content: AssistantAttachmentItem[];
};
let mounted: ReturnType<typeof mountSolid<AttachmentTestProps>> | undefined;

function AttachmentContent(props: AttachmentTestProps) {
  const media = createMemo(() => projectMessageMedia({}, props.content));
  return (
    <>
      <MessageImages images={media().images} options={props.options} />
      <AssistantAttachments {...props} attachments={media().attachments} />
    </>
  );
}

function draw(
  content: AssistantAttachmentItem | AssistantAttachmentItem[],
  overrides: Partial<Omit<AttachmentTestProps, "content">> = {},
) {
  const props = {
    content: Array.isArray(content) ? content : [content],
    options: {},
    inlinePlayback: true,
    ...overrides,
  };
  if (mounted) {
    mounted.update(props);
  } else {
    mounted = mountSolid(AttachmentContent, props, container);
  }
}

function drawReactive(
  content: () => AssistantAttachmentItem[],
  options: AttachmentTestProps["options"] = {},
  onOpenSidebar?: AttachmentTestProps["onOpenSidebar"],
) {
  const update = () =>
    draw(content(), { options: { ...options, mediaOwner: update }, onOpenSidebar });
  subscribers.add(update);
  update();
}

function managedAttachment(url: string, artifactId?: string): AttachmentItem {
  return makeAttachment(url, "asset.bin", "application/octet-stream", { artifactId });
}

function svgAttachment(
  url: string,
  label = "vector.svg",
  overrides: Partial<AttachmentItem["attachment"]> = {},
): AttachmentItem {
  return makeAttachment(url, label, "image/svg+xml", overrides);
}

async function flushAttachmentResolution() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

const svgResponse = (body = '<svg xmlns="http://www.w3.org/2000/svg"></svg>') =>
  new Response(body, { headers: { "Content-Type": "image/svg+xml" } });

const subscribers = new Set<() => void>();

function stubAttachmentIntersection(): () => Promise<void> {
  const callbacks: IntersectionObserverCallback[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  return async () => {
    await vi.waitFor(() => expect(callbacks.length).toBeGreaterThan(0));
    callbacks.shift()?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  };
}

afterEach(() => {
  mounted?.dispose();
  mounted = undefined;
  for (const subscriber of subscribers) {
    releaseChatMediaResourceOwner(subscriber);
  }
  subscribers.clear();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("attachment sidebar source ownership", () => {
  it("preserves an ordinary comment-named file when its source cannot be previewed", async () => {
    const onOpenSidebar = vi.fn();
    draw(makeAttachment("https://files.example/notes.txt", "selection-comment.txt", "text/plain"), {
      onOpenSidebar,
      inlinePlayback: false,
    });
    await vi.waitFor(() => expect(text("__title")).toContain("selection-comment.txt"));
    expandCard();
    expect(onOpenSidebar).toHaveBeenCalledOnce();
  });

  it.each([
    ["sample-image.png", "image/png", "https://example.com/sample-image.png"],
    ["photo.png", "application/octet-stream", `${window.location.origin}/download/opaque`],
    [
      "photo",
      "application/octet-stream; charset=binary",
      `${window.location.origin}/download/photo.png`,
    ],
  ])(
    "renders document-shaped %s attachments as expandable images",
    async (label, mimeType, source) => {
      const onOpenImage = vi.fn();
      draw(makeAttachment(source, label, mimeType), { options: { onOpenImage } });

      expect(card("")).toBeNull();
      await waitForSolid(() => expect(imageNode()?.getAttribute("src")).toBe(source));
      imageButton()?.click();
      expect(onOpenImage).toHaveBeenCalledWith(
        expect.objectContaining({ src: source, title: label }),
      );
    },
  );

  it.each([
    { kind: "image", outcome: "offline" },
    { kind: "image", outcome: "missing" },
    { kind: "document", outcome: "denied" },
  ] as const)(
    "handles $outcome renewal after a local $kind raster has loaded",
    async ({ kind, outcome }) => {
      vi.useFakeTimers();
      const availableResponse = (mediaTicket: string) => ticketResponse(mediaTicket, 31_000);
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(availableResponse("loaded"));
      vi.stubGlobal("fetch", fetchMock);
      const attachment = makeAttachment(
        `/tmp/openclaw/${crypto.randomUUID()}.png`,
        "photo.png",
        "image/png",
        { kind },
      );
      const rerender = () =>
        draw(attachment, { options: { authToken: "test-token", mediaOwner: rerender } });
      subscribers.add(rerender);
      rerender();
      await vi.advanceTimersByTimeAsync(0);
      const displayed = expectDefined(container.querySelector("img"), "loaded raster image");
      expect(displayed.getAttribute("src")).toContain("mediaTicket=loaded");
      Object.defineProperty(displayed, "naturalWidth", { value: 1 });
      displayed.dispatchEvent(new Event("load"));
      if (outcome === "offline") {
        fetchMock.mockRejectedValue(new TypeError("Gateway offline"));
        await vi.advanceTimersByTimeAsync(11_000);
        expect(container.querySelector("img")).toBe(displayed);
        await vi.advanceTimersByTimeAsync(20_001);
        expect(container.querySelector("img")).toBe(displayed);
        expect(card("")).toBeNull();
      } else {
        const retryable = outcome === "missing";
        fetchMock.mockResolvedValueOnce(
          Response.json({ available: false, reason: "Attachment removed", retryable }),
        );
        await vi.advanceTimersByTimeAsync(1_000);
        expect(container.querySelector("img")).toBeNull();
        displayed.dispatchEvent(new Event("load"));
        displayed.dispatchEvent(new Event("error"));
        expect(container.querySelector("img")).toBeNull();
        const retry = action("retry");
        if (outcome === "missing") {
          expect(container.textContent).toContain("Attachment removed");
          fetchMock.mockResolvedValueOnce(availableResponse("recovered"));
          expectDefined(retry, "Retry action for a recoverable missing image").click();
          await vi.advanceTimersByTimeAsync(0);
          expect(container.querySelector("img")?.getAttribute("src")).toContain(
            "mediaTicket=recovered",
          );
        } else {
          expect(container.textContent).toContain("Unavailable");
          expect(retry).toBeNull();
        }
      }
    },
  );

  it("routes an SVG filename with an opaque source through the bounded SVG renderer", () => {
    draw(
      makeAttachment(
        "https://files.example/download/opaque",
        "vector.svg",
        "application/octet-stream",
      ),
    );

    expect(svgElement()).not.toBeNull();
    expect(imageNode()).toBeNull();
  });

  it("does not let an SVG-shaped label override a document MIME type", () => {
    draw(makeAttachment("https://files.example/document.pdf", "vector.svg", "application/pdf"));

    expect(svgElement()).toBeNull();
    expect(card("")).not.toBeNull();
  });

  it("reloads SVG attachments on reconnect and retains object URLs for open viewers", async () => {
    const intersectAttachment = stubAttachmentIntersection();
    const source = `${window.location.origin}/vector.svg`;
    let objectUrl = "blob:svg-attachment";
    let objectBlob: Blob | undefined;
    const revokeObjectURL = vi.fn();
    stubObjectUrls((object) => {
      if (object instanceof Blob) {
        objectBlob = object;
      }
      return objectUrl;
    }, revokeObjectURL);
    const fetchMock = vi.fn<typeof fetch>(async () =>
      svgResponse('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>'),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onOpenImage = vi.fn();
    const onAssistantAttachmentLoaded = vi.fn();
    draw(svgAttachment(source), { options: { onOpenImage }, onAssistantAttachmentLoaded });

    expect(fetchMock).not.toHaveBeenCalled();
    await intersectAttachment();

    await vi.waitFor(() => expect(imageNode()?.getAttribute("src")).toBe(objectUrl));
    expect(fetchMock.mock.lastCall?.[1]?.credentials).toBe("same-origin");
    expect(objectBlob?.type).toBe("image/svg+xml");
    const svg = svgElement()!;
    svg.label = "Renamed vector";
    await svg.updateComplete;
    expect(imageNode()?.getAttribute("src")).toBe(objectUrl);
    expect(imageNode()?.getAttribute("alt")).toBe("Renamed vector");
    svg.label = "vector.svg";
    await svg.updateComplete;
    expect(container.querySelector("iframe")).toBeNull();
    svg.remove();
    await Promise.resolve();
    objectUrl = "blob:svg-reconnected";
    container.append(svg);
    await intersectAttachment();
    await vi.waitFor(() => expect(imageNode()?.getAttribute("src")).toBe(objectUrl));
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:svg-attachment");
    revokeObjectURL.mockClear();
    imageNode()?.dispatchEvent(new Event("load"));
    expect(onAssistantAttachmentLoaded).toHaveBeenCalledOnce();
    imageButton()?.click();
    expect(onOpenImage).toHaveBeenCalledWith(
      expect.objectContaining({ src: objectUrl, title: "vector.svg" }),
    );
    const lightboxItem = onOpenImage.mock.calls[0]?.[0] as { release?: () => void } | undefined;
    expect(lightboxItem?.release).toBeTypeOf("function");
    imageButton()?.click();
    const secondLightboxItem = onOpenImage.mock.calls[1]?.[0] as
      | { release?: () => void }
      | undefined;
    expect(secondLightboxItem?.release).toBeTypeOf("function");
    container.remove();
    await Promise.resolve();
    expect(revokeObjectURL).not.toHaveBeenCalledWith(objectUrl);
    lightboxItem?.release?.();
    lightboxItem?.release?.();
    expect(revokeObjectURL).not.toHaveBeenCalledWith(objectUrl);
    secondLightboxItem?.release?.();
    secondLightboxItem?.release?.();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(objectUrl);
  });

  it("keeps a cross-origin SVG with an extensionless label compact under the image CSP", async () => {
    const source = "https://cdn.example/vector.svg";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const onOpenSidebar = vi.fn();
    draw(makeAttachment(source, "diagram", undefined, { kind: "image" }), { onOpenSidebar });

    await vi.waitFor(() => expect(card("--compact")).not.toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(imageNode()).toBeNull();
    expandCard();
    expect(onOpenSidebar).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "attachment", attachmentKind: "image", src: source }),
    );
  });

  it.each(["size", "chunk", "timeout", "decode"] as const)(
    "keeps an SVG compact after %s failure",
    async (failure) => {
      const name =
        { size: "oversized", chunk: "chunked", timeout: "stalled", decode: "broken" }[failure] +
        ".svg";
      const cancel = vi.fn();
      const createObjectURL = vi.fn(() => "blob:broken-svg");
      const onOpenSidebar = vi.fn();
      const onAssistantAttachmentLoaded = vi.fn();
      stubObjectUrls(createObjectURL);
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetchMock);
      let intersect: (() => Promise<void>) | undefined;
      if (failure === "chunk") {
        intersect = stubAttachmentIntersection();
        fetchMock.mockResolvedValue(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(256 * 1024 + 1));
              },
              cancel,
            }),
            { headers: { "Content-Type": "image/svg+xml" } },
          ),
        );
      } else if (failure === "timeout") {
        vi.useFakeTimers();
        intersect = stubAttachmentIntersection();
        fetchMock.mockImplementation(
          (_input, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => reject(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            }),
        );
      } else if (failure === "decode") {
        fetchMock.mockResolvedValue(svgResponse("<svg><broken"));
      }
      draw(
        svgAttachment(
          `${window.location.origin}/${name}`,
          name,
          failure === "size" ? { sizeBytes: 256 * 1024 + 1 } : {},
        ),
        {
          onOpenSidebar: failure === "decode" ? onOpenSidebar : undefined,
          onAssistantAttachmentLoaded:
            failure === "timeout" ? onAssistantAttachmentLoaded : undefined,
        },
      );
      await intersect?.();
      if (failure === "timeout") {
        await vi.advanceTimersByTimeAsync(10_000);
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(onAssistantAttachmentLoaded).toHaveBeenCalledOnce();
      } else if (failure === "decode") {
        const failed = await vi.waitFor(() => expectDefined(imageNode(), "SVG image"));
        failed.dispatchEvent(new Event("error"));
      }
      await vi.waitFor(() => expect(card("--compact")).not.toBeNull());
      if (failure === "size") {
        expect(fetchMock).not.toHaveBeenCalled();
      } else if (failure === "chunk") {
        expect(cancel).toHaveBeenCalledOnce();
        expect(createObjectURL).not.toHaveBeenCalled();
      } else if (failure === "decode") {
        expect(imageNode()).toBeNull();
        expect(text("__title")).toContain("broken.svg");
        expandCard();
        expect(onOpenSidebar).toHaveBeenCalledOnce();
      }
    },
  );

  it("retries a failed managed attachment resolution", async () => {
    const attachmentId = crypto.randomUUID();
    const artifactId = `artifact_managed_document_${attachmentId}`;
    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${attachmentId}/full`;
    const ticketedUrl = `${source}?mediaTicket=recovered`;
    const resolveArtifactDownload = vi
      .fn<() => Promise<{ url: string } | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ url: ticketedUrl });
    drawReactive(() => [managedAttachment(source, artifactId)], {
      resolveArtifactDownload,
      resourceBasePath: "/rosita",
    });
    await flushAttachmentResolution();
    expect(card("--blocked")).not.toBeNull();

    action("retry")?.click();
    await flushAttachmentResolution();

    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
    expect(card("--blocked")).toBeNull();
    expect(attr("__download", "href")).toBe(`/rosita${ticketedUrl}`);
  });

  it("does not expose a Files action without a sidebar owner", () => {
    draw(managedAttachment("https://example.com/asset.bin"));

    expect(action("expand")).toBeNull();
    expect(card("")?.hasAttribute("data-openable")).toBe(false);
  });

  it("renders attachment failures with separable status and reason text", () => {
    const code = "unsupported-format";
    const label = "settings.toml";
    const reason = "Rejected by the local attachment allowlist. Send a supported file type.";
    draw(
      expectDefined(
        normalizeAttachmentContentBlock({
          type: "attachment_error",
          attachment: { code, kind: "document", label },
        }),
        "normalized attachment failure",
      ),
    );

    expect(text("__title")).toBe(label);
    expect(container.querySelectorAll(".chat-assistant-attachment-card")).toHaveLength(1);
    expect(container.querySelector(".chat-assistant-attachment-card--definitive")).not.toBeNull();
    expect(text("__status-badge")).toBe("Not sent");
    expect(text("__status-separator")).toBe("·");
    expect(attr("__status-separator", "aria-hidden")).toBe("true");
    expect(text("__status-reason")).toBe(reason);
    expect(text("__status-meta")?.replace(/\s+/gu, " ").trim()).toBe(`Not sent · ${reason}`);
    expect(
      container.querySelector(
        ".chat-assistant-attachment-card__download, .chat-assistant-attachment-card__expand, .chat-assistant-attachment-card__retry",
      ),
    ).toBeNull();
  });

  it("renders normalized base64 audio with inline playback and Files actions", () => {
    const onOpenSidebar = vi.fn();
    draw(
      makeAttachment("data:audio/wav;base64,UklGRg==", "inline.wav", "audio/wav", {
        kind: "audio",
      }),
      { onOpenSidebar },
    );

    const player = container.querySelector("openclaw-chat-audio-player");
    expect(player).toMatchObject({
      label: "inline.wav",
      mimeType: "audio/wav",
      onExpand: expect.any(Function),
      sourceIdentity: "data:audio/wav;base64,UklGRg==",
      src: "data:audio/wav;base64,UklGRg==",
    });
    expect(card("--compact")).toBeNull();
    (player as HTMLElement & { onExpand: () => void }).onExpand();
    expect(onOpenSidebar).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentKind: "audio",
        src: "data:audio/wav;base64,UklGRg==",
      }),
    );
    expect(onOpenSidebar.mock.lastCall?.[0]).not.toHaveProperty("resolveSource");
  });

  it("retains an open local sidebar attachment's message while refreshing runtime credentials", async () => {
    const source = "/tmp/openclaw/clip.mp3";
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const token = new Headers(init?.headers).get("Authorization")?.replace("Bearer ", "") ?? "";
      return Response.json({
        available: true,
        mediaTicket: `ticket-${token}`,
        mediaTicketExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    let sidebarContent: AttachmentSidebarContent | undefined;
    drawReactive(
      () => [makeAttachment(source, "clip.mp3", "audio/mpeg", { kind: "audio" })],
      {
        authToken: "token-A",
        sessionKey: "agent:main:sidebar-audio",
        messageId: "saved-audio-message",
      },
      (content) => {
        if (content.kind === "attachment") {
          sidebarContent = content;
        }
      },
    );
    const expand = await vi.waitFor(() =>
      expectDefined(action("expand"), "available attachment expand action"),
    );
    expand.click();

    const sidebarUpdate = vi.fn();
    subscribers.add(sidebarUpdate);
    const resolveSource = sidebarContent?.resolveSource;
    expect(resolveSource).toBeDefined();
    const refreshSource = () =>
      resolveSource?.(sidebarUpdate, {
        authToken: "token-B",
        sessionKey: "agent:main:sidebar-audio",
      });
    expect(refreshSource()).toEqual({ status: "pending" });
    await vi.waitFor(() =>
      expect(refreshSource()).toEqual(
        expect.objectContaining({
          authToken: "token-B",
          src: expect.stringContaining("mediaTicket=ticket-token-B"),
        }),
      ),
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers).get("Authorization")).toBe(
      "Bearer token-B",
    );
    expect(
      fetchMock.mock.calls.map(([url]) =>
        new URL(url instanceof Request ? url.url : url, window.location.origin).searchParams.get(
          "messageId",
        ),
      ),
    ).toEqual(["saved-audio-message", "saved-audio-message"]);
    const refreshed = refreshSource();
    expect(refreshed?.status).toBe("ready");
    if (refreshed?.status === "ready") {
      const params = new URL(refreshed.src, window.location.origin).searchParams;
      expect(params.get("messageId")).toBe("saved-audio-message");
      expect(params.get("sessionKey")).toBe("agent:main:sidebar-audio");
      expect(params.get("mediaTicket")).toBe("ticket-token-B");
    }
  });
});
