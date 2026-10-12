/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMessageAttachment } from "./chat-message-attachments.ts";
import {
  releaseChatMediaResourceSubscriber,
  type AttachmentItem,
  type ImageRenderOptions,
} from "./chat-message-media.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

const observations: Array<{ element: Element; show: () => void }> = [];
const subscribers = new Set<() => void>();
const containers = new Set<HTMLElement>();

beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(element: Element) {
        observations.push({
          element,
          show: () =>
            this.callback(
              [{ target: element, isIntersecting: true } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver,
            ),
        });
      }
      disconnect() {}
    },
  );
});

afterEach(() => {
  for (const container of containers) {
    render(null, container);
    container.remove();
  }
  for (const subscriber of subscribers) {
    releaseChatMediaResourceSubscriber(subscriber);
  }
  containers.clear();
  subscribers.clear();
  observations.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function settle() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function mount(
  item: AttachmentItem,
  options: ImageRenderOptions = {},
  onOpenSidebar?: (content: SidebarContent) => void,
  presentation: "inline" | "card" | "preview" = "inline",
) {
  const container = document.body.appendChild(document.createElement("div"));
  containers.add(container);
  let current = item;
  const update = () =>
    render(
      renderMessageAttachment(
        current,
        { ...options, onRequestUpdate: update },
        onOpenSidebar,
        undefined,
        presentation,
      ),
      container,
    );
  subscribers.add(update);
  update();
  return {
    container,
    replace(next: AttachmentItem) {
      current = next;
      update();
    },
  };
}

function localAttachment(
  kind: AttachmentItem["attachment"]["kind"],
  label: string,
): AttachmentItem {
  return {
    type: "attachment",
    attachment: { kind, label, url: `/tmp/openclaw/${crypto.randomUUID()}/${label}` },
  };
}

describe("nonimage attachment source admission", () => {
  it.each([
    ["document", "notes.pdf", "inline", true],
    ["audio", "recording.mp3", "card", true],
    ["video", "recording.mp4", "card", true],
    ["audio", "recording.mp3", "inline", false],
    ["video", "recording.mp4", "inline", false],
    ["video", "preview.mp4", "preview", false],
    ["document", "drawing.svg", "card", false],
  ] as const)(
    "routes %s %s %s metadata through its source owner (deferred=%s)",
    async (kind, label, presentation, deferred) => {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        Response.json(
          deferred
            ? { available: false, reason: "Fixture missing", retryable: false }
            : { available: false },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const first = mount(localAttachment(kind, label), {}, undefined, presentation);
      if (deferred) {
        mount(localAttachment(kind, `other-${label}`), {}, undefined, presentation);
      }
      await settle();
      if (deferred) {
        expect(first.container.textContent).toContain(label);
        expect(fetchMock).not.toHaveBeenCalled();
        const observation = observations.find(({ element }) => first.container.contains(element));
        expect(observation).toBeDefined();
        observation?.show();
        await settle();
      } else {
        expect(observations).toHaveLength(0);
      }
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("defers a managed ticket without delaying the admitted download", async () => {
    const url = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
    const resolveArtifactDownload = vi.fn(async () => ({ url: `${url}?mediaTicket=fixture` }));
    const { container } = mount(
      {
        type: "attachment",
        attachment: { kind: "document", label: "notes.pdf", url, artifactId: "fixture-document" },
      },
      { resolveArtifactDownload },
    );
    await settle();
    expect(resolveArtifactDownload).not.toHaveBeenCalled();
    observations[0]?.show();
    await settle();

    expect(resolveArtifactDownload).toHaveBeenCalledOnce();
    expect(container.querySelector("a[download]")?.getAttribute("href")).toBe(
      `${url}?mediaTicket=fixture`,
    );
  });

  it("ignores stale admission after source replacement and disconnect", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ available: false, reason: "Fixture missing", retryable: false }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const first = localAttachment("document", "first.pdf");
    const view = mount(first);
    const stale = observations[0];
    view.replace(localAttachment("document", "second.pdf"));
    view.replace(first);
    stale?.show();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();

    const current = observations.at(-1);
    render(null, view.container);
    await settle();
    current?.show();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens a deferred file with the sidebar's current authority without a viewport callback", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        available: true,
        mediaTicket: "current-authority",
        mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onOpenSidebar = vi.fn<(content: SidebarContent) => void>();
    const { container } = mount(localAttachment("document", "explicit.pdf"), {}, onOpenSidebar);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();

    container.querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__expand")?.click();
    expect(onOpenSidebar).toHaveBeenCalledOnce();
    const content = onOpenSidebar.mock.calls[0]?.[0];
    expect(content?.kind).toBe("attachment");
    if (content?.kind !== "attachment") {
      throw new Error("Missing attachment sidebar");
    }
    const sidebarUpdate = vi.fn();
    subscribers.add(sidebarUpdate);
    const runtime = { authToken: "current-sidebar-token" };
    expect(content.resolveSource?.(sidebarUpdate, runtime)).toEqual({ status: "pending" });
    await settle();
    expect(content.resolveSource?.(sidebarUpdate, runtime)).toMatchObject({
      status: "ready",
      src: expect.stringContaining("mediaTicket=current-authority"),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer current-sidebar-token",
    );
  });

  it.each(["https://files.example.test/recording.mp3", "data:audio/wav;base64,UklGRg=="])(
    "preserves ongoing static playback across authority updates for %s",
    async (url) => {
      const options: ImageRenderOptions = { authToken: "initial-token", connectionEpoch: 1 };
      const item: AttachmentItem = {
        type: "attachment",
        attachment: { kind: "audio", label: "recording.wav", mimeType: "audio/wav", url },
      };
      const view = mount(item, options);
      await settle();
      const media = view.container.querySelector("audio");
      expect(media).not.toBeNull();
      if (!media) {
        throw new Error("Missing native audio playback");
      }
      media.currentTime = 42;
      Object.defineProperty(media, "paused", { configurable: true, value: false });
      const pause = vi.spyOn(media, "pause").mockImplementation(() => undefined);
      options.authToken = "current-token";
      options.connectionEpoch = 2;
      view.replace(item);
      await settle();

      expect(view.container.querySelector("audio")).toBe(media);
      expect(media.currentTime).toBe(42);
      expect(pause).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["inline", false],
    ["preview", true],
  ] as const)(
    "preserves %s voice-note expansion controls before admission",
    async (presentation, expandable) => {
      const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ available: false }));
      vi.stubGlobal("fetch", fetchMock);
      const item = localAttachment("audio", "voice.wav");
      item.attachment.isVoiceNote = true;
      const onOpenSidebar = vi.fn<(content: SidebarContent) => void>();
      const { container } = mount(item, {}, onOpenSidebar, presentation);
      await settle();

      expect(Boolean(container.querySelector(".chat-assistant-attachment-card__expand"))).toBe(
        expandable,
      );
      container.querySelector<HTMLElement>(".chat-assistant-attachment-card")?.click();
      expect(onOpenSidebar).toHaveBeenCalledTimes(expandable ? 1 : 0);
      expect(fetchMock).toHaveBeenCalledTimes(presentation === "inline" ? 1 : 0);
    },
  );
});
