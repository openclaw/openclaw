/* @vitest-environment jsdom */

import { createComponent, createSignal, getOwner } from "solid-js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { AssistantAttachments, MessageAttachment } from "./chat-message-attachments-solid.tsx";
import { managedSource, ticketResponse } from "./chat-message-media.test-helpers.ts";
import {
  releaseChatMediaResourceOwner,
  type AttachmentItem,
  type ImageRenderOptions,
} from "./chat-message-media.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

beforeAll(async () => {
  // Admission, not cold Vite transformation of the lazy excerpt parser, is under test.
  await import("../../../lib/chat/pasted-text-excerpt.ts");
});

const observations: Array<{ element: Element; show: () => void }> = [];
const subscribers = new Set<() => void>();
const views = new Set<ReturnType<typeof mountSolid>>();

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
  for (const view of views) {
    view.unmount();
  }
  for (const subscriber of subscribers) {
    releaseChatMediaResourceOwner(subscriber);
  }
  views.clear();
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
  let current = item;
  const propsForItem = (): { item: AttachmentItem; options: ImageRenderOptions } => ({
    item: current,
    options: { ...options, mediaOwner: update },
  });
  let setProps: (props: ReturnType<typeof propsForItem>) => void;
  const update = () => {
    setProps(propsForItem());
    if (!getOwner()) {
      flush();
    }
  };
  const view = mountSolid(() => {
    const [props, setCurrent] = createSignal(propsForItem(), { ownedWrite: true });
    setProps = setCurrent;
    return createComponent(MessageAttachment, {
      get item() {
        return props().item;
      },
      get options() {
        return props().options;
      },
      onOpenSidebar,
      presentation,
    });
  });
  views.add(view);
  subscribers.add(update);
  return {
    ...view,
    replace(next: AttachmentItem) {
      current = next;
      update();
    },
  };
}

function fetchResponse(
  response: (...args: Parameters<typeof fetch>) => Response | Promise<Response> = () =>
    Response.json({ available: false }),
) {
  const mock = vi.fn<typeof fetch>(async (...args) => response(...args));
  vi.stubGlobal("fetch", mock);
  return mock;
}

function observationFor(container: HTMLElement) {
  const observation = observations.find(({ element }) => container.contains(element));
  expect(observation).toBeDefined();
  return observation!;
}

function localAttachment(
  kind: AttachmentItem["attachment"]["kind"],
  label: string,
  overrides: Partial<AttachmentItem["attachment"]> = {},
): AttachmentItem {
  return {
    type: "attachment",
    attachment: { kind, label, url: `/tmp/openclaw/${crypto.randomUUID()}/${label}`, ...overrides },
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
      const fetchMock = fetchResponse(() =>
        Response.json(
          deferred
            ? { available: false, reason: "Fixture missing", retryable: false }
            : { available: false },
        ),
      );
      const first = mount(localAttachment(kind, label), {}, undefined, presentation);
      if (deferred) {
        mount(localAttachment(kind, `other-${label}`), {}, undefined, presentation);
      }
      await settle();
      if (deferred) {
        expect(first.container.textContent).toContain(label);
        expect(fetchMock).not.toHaveBeenCalled();
        observationFor(first.container).show();
        await settle();
      } else {
        expect(observations).toHaveLength(0);
      }
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("defers a managed ticket without delaying the admitted download", async () => {
    const url = managedSource();
    const resolveArtifactDownload = vi.fn(async () => ({ url: `${url}?mediaTicket=fixture` }));
    const { container } = mount(
      localAttachment("document", "notes.pdf", { url, artifactId: "fixture-document" }),
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

  it("opens a deferred file with the sidebar's current authority without a viewport callback", async () => {
    const fetchMock = fetchResponse(() => ticketResponse("current-authority"));
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
      const item = localAttachment("audio", "recording.wav", { mimeType: "audio/wav", url });
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
      const fetchMock = fetchResponse();
      const item = localAttachment("audio", "voice.wav", { isVoiceNote: true });
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

const commentText =
  "Selected text:\nhello\n\nSource session: agent:main:main\nDOM text UTF-16 range: [0, 5)";

function textAttachment(kind: "comment" | "paste", managed = false): AttachmentItem {
  const id = crypto.randomUUID();
  const label = kind === "comment" ? "selection-comment.txt" : "pasted-text-123.txt";
  return localAttachment("document", label, {
    mimeType: "text/plain",
    ...(managed ? { url: managedSource(id), artifactId: id } : {}),
  });
}

async function settleText(container: HTMLElement) {
  flush();
  for (let index = 0; index < 16; index++) {
    await Promise.all(
      Array.from(
        container.querySelectorAll<HTMLElement & { updateComplete?: Promise<unknown> }>(
          "openclaw-chat-pasted-text",
        ),
      ).flatMap((element) => (element.updateComplete ? [element.updateComplete] : [])),
    );
    flush();
  }
}

function mountText(
  item: AttachmentItem | AttachmentItem[],
  options: ImageRenderOptions = {},
  inlineComments = false,
) {
  const [current, setCurrent] = createSignal(Array.isArray(item) ? item : [item]);
  const [revision, setRevision] = createSignal(0);
  const open = vi.fn();
  const update = () => setRevision((value) => value + 1);
  const view = mountSolid(() =>
    createComponent(AssistantAttachments, {
      get attachments() {
        return current();
      },
      get options() {
        revision();
        return { ...options, mediaOwner: update };
      },
      onOpenSidebar: open,
      inlinePlayback: false,
      inlineComments,
    }),
  );
  views.add(view);
  subscribers.add(update);
  return {
    ...view,
    open,
    replace(next: AttachmentItem) {
      setCurrent([next]);
    },
  };
}

describe("deferred attachment source admission", () => {
  it.each([
    ["comment", "viewport", true],
    ["comment", "viewport", false],
    ["paste", "viewport", false],
    ["comment", "focus", false],
    ["paste", "focus", false],
  ] as const)(
    "admits %s through %s (grouped=%s) while retaining the chip",
    async (kind, trigger, grouped) => {
      const managed = trigger === "focus";
      const item = textAttachment(kind, managed);
      const managedItem = grouped ? textAttachment("comment", true) : item;
      const resolveArtifactDownload = vi.fn(async () => ({
        url: `${managedItem.attachment.url}?mediaTicket=managed-text`,
        ...(managed ? { expiresAt: new Date(Date.now() + 300_000).toISOString() } : {}),
      }));
      const fetchMock = fetchResponse((input) =>
        !managed && (input instanceof Request ? input.url : String(input)).includes("meta=1")
          ? ticketResponse("text-chip")
          : new Response(managed || kind === "comment" ? commentText : "Visible pasted excerpt"),
      );
      const view = mountText(
        grouped ? [item, managedItem] : item,
        managed || grouped ? { resolveArtifactDownload } : {},
      );
      await settleText(view.container);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(resolveArtifactDownload).not.toHaveBeenCalled();
      const chip = view.container.querySelector<HTMLElement>(".chat-selection-annotations__chip");
      expect(chip).not.toBeNull();
      if (managed) {
        chip?.focus();
        await settleText(view.container);
        expect(resolveArtifactDownload).toHaveBeenCalledOnce();
        expect(document.activeElement).toBe(chip);
      } else {
        const observation = observationFor(view.container);
        expect(observation.element).toBe(chip);
        if (grouped) {
          expect(observations).toHaveLength(1);
        }
        observation.show();
        await settleText(view.container);
        expect(fetchMock).toHaveBeenCalledTimes(kind === "comment" ? 1 : 2);
        expect(view.container.querySelector(".chat-selection-annotations__chip")).toBe(chip);
        if (grouped) {
          expect(resolveArtifactDownload).toHaveBeenCalledOnce();
          chip?.focus();
        } else {
          chip?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
        }
        await settleText(view.container);
        expect(fetchMock).toHaveBeenCalledTimes(grouped ? 3 : 2);
        if (grouped) {
          expect(
            view.container.querySelectorAll(".chat-comment-preview__text--selection"),
          ).toHaveLength(2);
        } else {
          await waitForSolid(() =>
            expect(view.container.textContent).toContain(
              kind === "comment" ? "hello" : "Visible pasted excerpt",
            ),
          );
        }
      }
      expect(view.container.querySelector(".chat-selection-annotations__chip")).toBe(chip);
      if (kind === "paste") {
        const activation = new KeyboardEvent("keydown", {
          key: trigger === "focus" ? " " : "Enter",
          bubbles: true,
          cancelable: true,
        });
        chip?.dispatchEvent(activation);
        expect(activation.defaultPrevented).toBe(true);
        expect(view.open).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            kind: "attachment",
            attachmentKind: "document",
            title: "pasted-text-123.txt",
            plainText: true,
            sourceIdentity: item.attachment.url,
          }),
        );
      }
    },
  );

  it.each(["document", "comment", "paste", "inline-comment"] as const)(
    "fences stale %s observations after source replacement and disconnect",
    async (kind) => {
      const fetchMock = fetchResponse(() =>
        Response.json(
          kind === "document"
            ? { available: false, reason: "Fixture missing", retryable: false }
            : { available: false },
        ),
      );
      const attachment = () =>
        kind === "document"
          ? localAttachment(kind, "file.pdf")
          : textAttachment(kind === "inline-comment" ? "comment" : kind);
      const first = attachment();
      const view =
        kind === "document"
          ? mount(first)
          : mountText(first, { messageSendId: "observer-send" }, kind === "inline-comment");
      const settled = () => (kind === "document" ? settle() : settleText(view.container));
      if (kind !== "document") {
        await settled();
      }
      const stale = kind === "document" ? observations[0] : observations.at(-1);
      expect(stale).toBeDefined();
      view.replace(attachment());
      if (kind === "document") {
        view.replace(first);
      } else {
        await settled();
      }
      stale?.show();
      if (kind === "document") {
        await settled();
      }
      expect(fetchMock).not.toHaveBeenCalled();
      const current = observations.at(-1);
      if (kind === "inline-comment") {
        current?.show();
        await settled();
        expect(fetchMock).toHaveBeenCalledOnce();
      }
      view.unmount();
      await settled();
      current?.show();
      await settled();
      expect(fetchMock).toHaveBeenCalledTimes(kind === "inline-comment" ? 1 : 0);
    },
  );
});
