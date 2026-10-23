/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  requireFetchCallForUrl,
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
import { createAssistantMessage, createAttachmentBlock } from "./chat-message.test-support.ts";

const harness = createChatMessageHarness();
const {
  requireElement,
  elementText,
  expectAbsent,
  renderAssistantMessage,
  markdownRenderMock,
  renderMarkdownHtml,
} = harness;

describe("grouped chat rendering", () => {
  function renderReactiveAssistant(
    message: () => unknown,
    options: Partial<RenderMessageGroupOptions>,
    container: HTMLElement = harness.view,
  ) {
    const rerender = () =>
      renderAssistantMessage(message(), { ...options, mediaOwner: rerender }, container);
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
      { showToolCalls: false, resolveArtifactDownload },
      container,
    );
    return container;
  }

  it("renders assistant MEDIA attachments without a strip for an unresolved current reply", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    const onOpenImage = vi.fn();
    await markdownRenderMock.withImplementation(renderMarkdownHtml, async () => {
      renderAssistantMessage(
        createAssistantMessage(
          "Here is the image.\nMEDIA:https://example.com/photo.png\nMEDIA:https://example.com/voice.ogg",
          {
            id: "assistant-media-inline",
            openclawDelivery: { replyToCurrent: true },
          },
        ),
        { showToolCalls: false, onOpenImage },
        container,
      );
      await vi.dynamicImportSettled();
    });

    expect(container.querySelector(".chat-reply-attribution")).toBeNull();
    expect(elementText(".chat-text > p:first-child", container)?.trim()).toBe("Here is the image.");
    expect(elementText(".chat-text", container)).not.toContain("MEDIA:");
    await waitForSolid(() =>
      expect(requireElement(".chat-message-image", HTMLImageElement, container).src).toBe(
        "https://example.com/photo.png",
      ),
    );
    requireElement(".chat-message-image-button", HTMLButtonElement, container).click();
    expect(onOpenImage).toHaveBeenCalledWith(
      expect.objectContaining({
        src: "https://example.com/photo.png",
        title: "photo.png",
      }),
    );
    await waitForSolid(() =>
      expect(elementText(".chat-assistant-attachment-card__title", container)).toBe("voice.ogg"),
    );
    requireElement("openclaw-chat-audio-player", HTMLElement, container);
  });

  it("resolves managed transcode audio to an inline player", async () => {
    const source = managedSource();
    const ticketedUrl = `${source}?mediaTicket=managed-ticket`;
    const artifactId = `artifact_managed_media_${crypto.randomUUID()}`;
    const resolveArtifactDownload = vi.fn(async () => ({ url: ticketedUrl }));
    const fetchMock = stubFetch();
    const container = document.body.appendChild(document.createElement("div"));
    renderReactiveAssistant(
      () =>
        nativeAudio(
          source,
          artifactId,
          {
            fileName: "voice.caf",
            mimeType: "audio/x-caf",
            playback: "transcode",
            sizeBytes: 4_096,
            durationMs: 2_345,
          },
          { id: "assistant-managed-transcode-audio" },
        ),
      {
        showToolCalls: false,
        assistantAttachmentAuthToken: "must-not-be-forwarded",
        resolveArtifactDownload,
      },
      container,
    );

    await vi.dynamicImportSettled();
    await waitForSolid(() =>
      expect(container.querySelector("openclaw-chat-audio-player")).not.toBeNull(),
    );
    expect(resolveArtifactDownload).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      artifactId,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${ticketedUrl}&playback=1`,
      expect.objectContaining({ method: "HEAD" }),
    );
    expect(attachmentDownload(container)?.getAttribute("href")).toBe(ticketedUrl);
    expect(container.querySelector("openclaw-chat-audio-player")).not.toBeNull();
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
    await waitForSolid(
      () => expect(container.querySelector("openclaw-chat-audio-player")).not.toBeNull(),
      { interval: 0 },
    );
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(1);
    expect(container.querySelector("openclaw-chat-audio-player")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(1);
    await advanceAttachments(1);
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
    expect(container.querySelector("openclaw-chat-audio-player")).not.toBeNull();

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
      await waitForSolid(
        () => expect(container.querySelector("openclaw-chat-audio-player")).not.toBeNull(),
        { interval: 0 },
      );
      await advanceAttachments(5_000);
      if (refreshFails) {
        expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
        expectManagedAudio(container, false);
        expect(attachmentDownload(container)?.getAttribute("href")).toContain(
          "mediaTicket=short-1",
        );
      }
      await advanceAttachments(10_000);
      expect(resolveArtifactDownload).toHaveBeenCalledTimes(3);
      expect(attachmentDownload(container)?.getAttribute("href")).toContain(
        `mediaTicket=short-${retainedTicket}`,
      );
      expectManagedAudio(container, false);
      await advanceAttachments(beforeExpiry);
      expect(container.querySelector("openclaw-chat-audio-player")).not.toBeNull();
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
        showToolCalls: false,
        resourceBasePath: "/openclaw",
        assistantAttachmentAuthToken: "session-token",
      },
    );

    await vi.dynamicImportSettled();
    await waitForSolid(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flushAttachmentChecks();

    await vi.waitFor(() => {
      expect(
        elementText(
          ".chat-assistant-attachment-card--blocked .chat-assistant-attachment-card__status-meta",
        ),
      ).toContain(reason);
    });
    expectAbsent("audio");
    expect(attachmentDownload(harness.view)).toBeNull();
  });

  it("renders a video attachment inline and expands it in the lightbox", () => {
    const fetchMock = stubFetch();
    const onOpenImage = vi.fn();
    const onOpenSidebar = vi.fn();
    const label = "clip.mp4";
    const mimeType = "video/mp4";
    const source = `https://example.com/${label}`;

    renderAssistantMessage(
      createAssistantMessage([createAttachmentBlock(source, "video", label, mimeType)]),
      { showToolCalls: false, onOpenImage, onOpenSidebar },
    );

    const player = requireElement("openclaw-chat-video-player", HTMLElement) as HTMLElement & {
      label: string;
      mimeType: string;
      onExpand: (src?: string) => void;
      sourceIdentity: string;
      src: string;
    };
    expect(player).toMatchObject({ label, mimeType, sourceIdentity: source, src: source });
    expectAbsent(".chat-assistant-attachment-card--compact");
    player.onExpand(source);
    expect(onOpenImage.mock.lastCall?.[0]).toMatchObject({
      kind: "video",
      originalSrc: source,
      src: source,
      title: label,
    });
    expect(onOpenSidebar).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
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
      showToolCalls: false,
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
        showToolCalls: false,
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
