/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createMemo, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { normalizeAttachmentContentBlock } from "../../../lib/chat/message-normalizer-attachments.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { AssistantAttachments } from "./chat-message-attachments-solid.tsx";
import { MessageImages } from "./chat-message-images-solid.tsx";
import { stubObjectUrls, ticketResponse } from "./chat-message-media.test-helpers.ts";
import {
  projectMessageMedia,
  releaseChatMediaResourceSubscriber,
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
const expandCard = () =>
  container.querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__expand")?.click();
const text = (part: string) => card(part)?.textContent;
const attr = (part: string, name: string) => card(part)?.getAttribute(name);

type AttachmentTestProps = Omit<Parameters<typeof AssistantAttachments>[0], "attachments"> & {
  content: AssistantAttachmentItem[];
};
const mounts = new Map<
  HTMLElement,
  {
    update: (props: AttachmentTestProps) => void;
    unmount: () => void;
  }
>();

function AttachmentContent(props: AttachmentTestProps) {
  const media = createMemo(() => projectMessageMedia({}, props.content));
  return (
    <>
      <MessageImages images={media().images} options={props.options} />
      <AssistantAttachments
        attachments={media().attachments}
        options={props.options}
        onOpenSidebar={props.onOpenSidebar}
        onAssistantAttachmentLoaded={props.onAssistantAttachmentLoaded}
        inlinePlayback={props.inlinePlayback}
      />
    </>
  );
}

function draw(
  content: AssistantAttachmentItem[],
  options: AttachmentTestProps["options"] = {},
  onOpenSidebar?: AttachmentTestProps["onOpenSidebar"],
  onAssistantAttachmentLoaded?: AttachmentTestProps["onAssistantAttachmentLoaded"],
  inlinePlayback = true,
) {
  const props = { content, options, onOpenSidebar, onAssistantAttachmentLoaded, inlinePlayback };
  const mounted = mounts.get(container);
  if (mounted) {
    mounted.update(props);
    flush();
  } else {
    const [current, update] = createSignal<AttachmentTestProps>(props, { ownedWrite: true });
    const root = mountSolid(() => <AttachmentContent {...current()} />, { container });
    mounts.set(container, { update, unmount: root.unmount });
  }
}

function unmountAttachments(target: HTMLElement) {
  mounts.get(target)?.unmount();
  mounts.delete(target);
}

function drawReactive(
  content: () => AssistantAttachmentItem[],
  options: AttachmentTestProps["options"] = {},
  onOpenSidebar?: AttachmentTestProps["onOpenSidebar"],
) {
  const update = () => draw(content(), { ...options, onRequestUpdate: update }, onOpenSidebar);
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
  for (const target of mounts.keys()) {
    unmountAttachments(target);
  }
  for (const subscriber of subscribers) {
    releaseChatMediaResourceSubscriber(subscriber);
  }
  subscribers.clear();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("attachment sidebar source ownership", () => {
  it("preserves an ordinary comment-named file when its source cannot be previewed", async () => {
    const onOpenSidebar = vi.fn();
    draw(
      [makeAttachment("https://files.example/notes.txt", "selection-comment.txt", "text/plain")],
      {},
      onOpenSidebar,
      undefined,
      false,
    );
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
  ])("renders document-shaped %s attachments as expandable images", (label, mimeType, source) => {
    const onOpenImage = vi.fn();
    draw([makeAttachment(source, label, mimeType)], { onOpenImage });

    expect(card("")).toBeNull();
    expect(imageNode()?.getAttribute("src")).toBe(source);
    container.querySelector<HTMLButtonElement>(".chat-message-image-button")?.click();
    expect(onOpenImage).toHaveBeenCalledWith(
      expect.objectContaining({ src: source, title: label }),
    );
  });

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
      onTestFinished(() => {
        unmountAttachments(container);
      });
      const attachment: AttachmentItem = {
        type: "attachment",
        attachment: {
          kind,
          label: "photo.png",
          mimeType: "image/png",
          url: `/tmp/openclaw/${crypto.randomUUID()}.png`,
        },
      };
      const rerender = () =>
        draw([attachment], {
          authToken: "test-token",
          onRequestUpdate: rerender,
        });
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
        const retry = container.querySelector<HTMLButtonElement>(
          ".chat-assistant-attachment-card__retry",
        );
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
      [
        makeAttachment(
          "https://files.example/download/opaque",
          "vector.svg",
          "application/octet-stream",
        ),
      ],
      {},
    );

    expect(container.querySelector("openclaw-chat-svg-attachment")).not.toBeNull();
    expect(imageNode()).toBeNull();
  });

  it("does not let an SVG-shaped label override a document MIME type", () => {
    draw(
      [makeAttachment("https://files.example/document.pdf", "vector.svg", "application/pdf")],
      {},
    );

    expect(container.querySelector("openclaw-chat-svg-attachment")).toBeNull();
    expect(card("")).not.toBeNull();
  });

  it("loads SVG attachments through an image object URL", async () => {
    const intersectAttachment = stubAttachmentIntersection();
    const source = `${window.location.origin}/vector.svg`;
    const objectUrl = "blob:svg-attachment";
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
    draw([svgAttachment(source)], { onOpenImage }, undefined, onAssistantAttachmentLoaded);

    expect(fetchMock).not.toHaveBeenCalled();
    await intersectAttachment();

    await vi.waitFor(() => expect(imageNode()?.getAttribute("src")).toBe(objectUrl));
    expect(fetchMock).toHaveBeenCalledWith(
      source,
      expect.objectContaining({
        credentials: "same-origin",
        headers: { Accept: "image/svg+xml" },
        method: "GET",
      }),
    );
    expect(objectBlob?.type).toBe("image/svg+xml");
    const svg = container.querySelector("openclaw-chat-svg-attachment")!;
    svg.label = "Renamed vector";
    await svg.updateComplete;
    expect(imageNode()?.getAttribute("src")).toBe(objectUrl);
    expect(imageNode()?.getAttribute("alt")).toBe("Renamed vector");
    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([source]);
    svg.label = "vector.svg";
    await svg.updateComplete;
    expect(container.querySelector("iframe")).toBeNull();
    imageNode()?.dispatchEvent(new Event("load"));
    expect(onAssistantAttachmentLoaded).toHaveBeenCalledOnce();
    container.querySelector<HTMLButtonElement>(".chat-message-image-button")?.click();
    expect(onOpenImage).toHaveBeenCalledWith(
      expect.objectContaining({ src: objectUrl, title: "vector.svg" }),
    );
    const lightboxItem = onOpenImage.mock.calls[0]?.[0] as { release?: () => void } | undefined;
    expect(lightboxItem?.release).toBeTypeOf("function");
    container.remove();
    await Promise.resolve();
    expect(revokeObjectURL).not.toHaveBeenCalledWith(objectUrl);
    lightboxItem?.release?.();
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl);
  });

  it("keeps a cross-origin SVG with an extensionless label compact under the image CSP", async () => {
    const source = "https://cdn.example/vector.svg";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const onOpenSidebar = vi.fn();
    draw([makeAttachment(source, "diagram", undefined, { kind: "image" })], {}, onOpenSidebar);

    await vi.waitFor(() => expect(card("--compact")).not.toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(imageNode()).toBeNull();
    expandCard();
    expect(onOpenSidebar).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "attachment", attachmentKind: "image", src: source }),
    );
  });

  it("reloads a same-origin SVG after its element reconnects", async () => {
    const intersectAttachment = stubAttachmentIntersection();
    const objectUrls = ["blob:svg-first", "blob:svg-second"];
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => objectUrls.shift() ?? "blob:extra");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const fetchMock = vi.fn<typeof fetch>(async () => svgResponse());
    vi.stubGlobal("fetch", fetchMock);
    draw([svgAttachment(`${window.location.origin}/reconnected.svg`, "reconnected.svg")], {});

    await intersectAttachment();
    await vi.waitFor(() => expect(imageNode()?.getAttribute("src")).toBe("blob:svg-first"));
    const attachment = container.querySelector("openclaw-chat-svg-attachment")!;
    attachment.remove();
    await Promise.resolve();
    container.append(attachment);
    await intersectAttachment();

    await vi.waitFor(() => expect(imageNode()?.getAttribute("src")).toBe("blob:svg-second"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
        [
          svgAttachment(
            `${window.location.origin}/${name}`,
            name,
            failure === "size" ? { sizeBytes: 256 * 1024 + 1 } : {},
          ),
        ],
        {},
        failure === "decode" ? onOpenSidebar : undefined,
        failure === "timeout" ? onAssistantAttachmentLoaded : undefined,
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
    drawReactive(() => [managedAttachment(source, artifactId)], { resolveArtifactDownload });
    await flushAttachmentResolution();
    expect(card("--blocked")).not.toBeNull();

    container.querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__retry")?.click();
    await flushAttachmentResolution();

    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
    expect(card("--blocked")).toBeNull();
    expect(attr("__download", "href")).toBe(ticketedUrl);
  });

  it("keeps static attachment URLs as static sidebar sources", async () => {
    const source = "https://example.com/clip.mp4";
    let sidebarContent: AttachmentSidebarContent | undefined;
    draw([managedAttachment(source)], {}, (content) => {
      if (content.kind === "attachment") {
        sidebarContent = content;
      }
    });
    expandCard();

    expect(sidebarContent?.src).toBe(source);
    expect(sidebarContent?.resolveSource).toBeUndefined();
  });

  it("does not expose a Files action without a sidebar owner", () => {
    draw([managedAttachment("https://example.com/asset.bin")]);

    expect(container.querySelector(".chat-assistant-attachment-card__expand")).toBeNull();
    expect(card("")?.hasAttribute("data-openable")).toBe(false);
  });

  it("prefixes managed attachment tickets with the Control UI resource base path", async () => {
    const attachmentId = crypto.randomUUID();
    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${attachmentId}/full`;
    const ticketedUrl = `${source}?mediaTicket=ticket`;
    const resolveArtifactDownload = vi.fn(async () => ({ url: ticketedUrl }));
    drawReactive(() => [managedAttachment(source, `artifact_${attachmentId}`)], {
      resourceBasePath: "/rosita",
      resolveArtifactDownload,
    });
    await flushAttachmentResolution();

    expect(attr("__download", "href")).toBe(`/rosita${ticketedUrl}`);
  });

  it.each([
    ["audio", "recording.ogg", "audio/ogg", "openclaw-chat-audio-player", "transcode"],
    ["video", "demo.webm", "video/webm", "openclaw-chat-video-player", "transcode"],
  ] as const)(
    "renders %s attachment %s with inline playback",
    (kind, label, mimeType, player, requestedPlayback) => {
      const source = `https://example.com/${label}`;
      const playback = requestedPlayback ?? "native";
      const onOpenSidebar = vi.fn();
      draw([makeAttachment(source, label, mimeType, { kind, playback })], {}, onOpenSidebar);

      const mediaPlayer = container.querySelector(player);
      expect(mediaPlayer).toMatchObject({ playback, sourceIdentity: source, src: source });
      container.remove();
    },
  );

  it.each([
    ["audio", "unsafe.mp3", "audio/mpeg", "javascript:alert(1)"],
    ["video", "unsafe.mp4", "video/mp4", "data:text/html;base64,PHNjcmlwdD4="],
  ] as const)("blocks unsafe %s player source %s", (kind, label, mimeType, url) => {
    draw([makeAttachment(url, label, mimeType, { kind })], {});

    expect(container.querySelector("openclaw-chat-audio-player")).toBeNull();
    expect(container.querySelector("openclaw-chat-video-player")).toBeNull();
    expect(container.querySelector("audio, video")).toBeNull();
    expect(card("--blocked")).not.toBeNull();
    expect(container.querySelector(".chat-assistant-attachment-card__download")).toBeNull();
    expect(container.textContent).toContain(label);
  });

  it.each([
    {
      code: "unsupported-format",
      label: "settings.toml",
      reason: "Rejected by the local attachment allowlist. Send a supported file type.",
    },
    {
      code: "invalid-reference",
      label: "Media not attached",
      reason: "Use a public HTTPS URL without credentials or attach a local file by a safe path.",
    },
  ])("renders $code failures with separable status and reason text", ({ code, label, reason }) => {
    draw(
      expectDefined(
        normalizeAttachmentContentBlock({
          type: "attachment_error",
          attachment: { code, kind: "document", label },
        }),
        "normalized attachment failure",
      ),
      {},
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
      [
        makeAttachment("data:audio/wav;base64,UklGRg==", "inline.wav", "audio/wav", {
          kind: "audio",
        }),
      ],
      {},
      onOpenSidebar,
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
      expectDefined(
        container.querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__expand"),
        "available attachment expand action",
      ),
    );
    expand.click();

    const sidebarUpdate = vi.fn();
    subscribers.add(sidebarUpdate);
    const resolveSource = sidebarContent?.resolveSource;
    expect(resolveSource).toBeDefined();
    expect(
      resolveSource?.(sidebarUpdate, {
        authToken: "token-B",
        sessionKey: "agent:main:sidebar-audio",
      }),
    ).toEqual({ status: "pending" });
    await vi.waitFor(() =>
      expect(
        resolveSource?.(sidebarUpdate, {
          authToken: "token-B",
          sessionKey: "agent:main:sidebar-audio",
        }),
      ).toEqual(
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
    const refreshed = resolveSource?.(sidebarUpdate, {
      authToken: "token-B",
      sessionKey: "agent:main:sidebar-audio",
    });
    expect(refreshed?.status).toBe("ready");
    if (refreshed?.status === "ready") {
      const params = new URL(refreshed.src, window.location.origin).searchParams;
      expect(params.get("messageId")).toBe("saved-audio-message");
      expect(params.get("sessionKey")).toBe("agent:main:sidebar-audio");
      expect(params.get("mediaTicket")).toBe("ticket-token-B");
    }
  });
});
