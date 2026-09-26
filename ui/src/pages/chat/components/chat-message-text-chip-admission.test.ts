/* @vitest-environment jsdom */

import { render, type LitElement } from "lit";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderAssistantAttachments } from "./chat-message-attachments.ts";
import {
  releaseChatMediaResourceSubscriber,
  type AttachmentItem,
  type ImageRenderOptions,
} from "./chat-message-media.ts";

const observations: Array<{ element: Element; show: () => void }> = [];
const views: Array<{ container: HTMLElement; update: () => void }> = [];
const commentText =
  "Selected text:\nhello\n\nSource session: agent:main:main\nDOM text UTF-16 range: [0, 5)";

beforeAll(async () => {
  // Admission, not cold Vite transformation of the lazy excerpt parser, is under test.
  await import("../../../lib/chat/pasted-text-excerpt.ts");
});

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
  for (const { container, update } of views) {
    render(null, container);
    container.remove();
    releaseChatMediaResourceSubscriber(update);
  }
  views.length = 0;
  observations.length = 0;
  vi.unstubAllGlobals();
});

function attachment(kind: "comment" | "paste", managed = false): AttachmentItem {
  const id = crypto.randomUUID();
  const label = kind === "comment" ? "selection-comment.txt" : "pasted-text-123.txt";
  return {
    type: "attachment",
    attachment: {
      kind: "document",
      label,
      mimeType: "text/plain",
      url: managed
        ? `/api/chat/media/outgoing/agent%3Amain%3Amain/${id}/full`
        : `/tmp/openclaw/${id}/${label}`,
      ...(managed ? { artifactId: id } : {}),
    },
  };
}

async function settle(container: HTMLElement) {
  for (let index = 0; index < 16; index++) {
    await Promise.all(
      [
        ...container.querySelectorAll<LitElement>(
          "openclaw-chat-sent-comments, openclaw-chat-pasted-text",
        ),
      ].map((element) => element.updateComplete),
    );
  }
}

function mount(item: AttachmentItem | AttachmentItem[], options: ImageRenderOptions = {}) {
  const container = document.body.appendChild(document.createElement("div"));
  let current = Array.isArray(item) ? item : [item];
  const open = vi.fn();
  const update = () =>
    render(
      renderAssistantAttachments(
        current,
        { ...options, onRequestUpdate: update },
        open,
        undefined,
        false,
      ),
      container,
    );
  views.push({ container, update });
  update();
  return {
    container,
    open,
    replace(next: AttachmentItem) {
      current = [next];
      update();
    },
  };
}

describe("history text chip source admission", () => {
  it("admits all metadata for a comment group at its single chip without reading bodies", async () => {
    const local = attachment("comment");
    const managed = attachment("comment", true);
    const resolveArtifactDownload = vi.fn(async () => ({
      url: `${managed.attachment.url}?mediaTicket=group`,
    }));
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      (typeof input === "string" ? input : input instanceof URL ? input.href : input.url).includes(
        "meta=1",
      )
        ? Response.json({
            available: true,
            mediaTicket: "group",
            mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
          })
        : new Response(commentText),
    );
    vi.stubGlobal("fetch", fetchMock);
    const view = mount([local, managed], { resolveArtifactDownload });
    await settle(view.container);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolveArtifactDownload).not.toHaveBeenCalled();
    const chip = view.container.querySelector<HTMLElement>(".chat-selection-annotations__chip");
    expect(observations).toHaveLength(1);
    expect(observations[0]?.element).toBe(chip);
    observations[0]?.show();
    await settle(view.container);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(resolveArtifactDownload).toHaveBeenCalledOnce();
    chip?.focus();
    await settle(view.container);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(view.container.querySelectorAll(".chat-comment-preview__text--selection")).toHaveLength(
      2,
    );
    expect(view.container.querySelector(".chat-selection-annotations__chip")).toBe(chip);
  });

  it.each(["comment", "paste"] as const)(
    "defers offscreen %s metadata at its actual chip and keeps body reads with the preview owner",
    async (kind) => {
      const fetchMock = vi.fn<typeof fetch>(async (input) =>
        (typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url
        ).includes("meta=1")
          ? Response.json({
              available: true,
              mediaTicket: "text-chip",
              mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
            })
          : new Response(kind === "comment" ? commentText : "Visible pasted excerpt"),
      );
      vi.stubGlobal("fetch", fetchMock);
      const view = mount(attachment(kind));
      await settle(view.container);
      expect(fetchMock).not.toHaveBeenCalled();
      const chip = view.container.querySelector<HTMLElement>(".chat-selection-annotations__chip");
      expect(chip).not.toBeNull();
      const observation = observations.find(({ element }) => element === chip);
      expect(observation).toBeDefined();
      observation?.show();
      await settle(view.container);
      expect(fetchMock).toHaveBeenCalledTimes(kind === "comment" ? 1 : 2);
      expect(view.container.querySelector(".chat-selection-annotations__chip")).toBe(chip);
      chip?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      await settle(view.container);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(view.container.textContent).toContain(
        kind === "comment" ? "hello" : "Visible pasted excerpt",
      );
    },
  );

  it.each(["comment", "paste"] as const)(
    "admits an explicitly focused managed %s without waiting for intersection",
    async (kind) => {
      const item = attachment(kind, true);
      const resolveArtifactDownload = vi.fn(async () => ({
        url: `${item.attachment.url}?mediaTicket=managed-text`,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }));
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => new Response(commentText)),
      );
      const view = mount(item, { resolveArtifactDownload });
      await settle(view.container);
      expect(resolveArtifactDownload).not.toHaveBeenCalled();
      const chip = view.container.querySelector<HTMLElement>(".chat-selection-annotations__chip");
      chip?.focus();
      await settle(view.container);
      expect(resolveArtifactDownload).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(chip);
      expect(view.container.querySelector(".chat-selection-annotations__chip")).toBe(chip);
    },
  );

  it.each(["comment", "paste"] as const)(
    "fences stale %s observations after source replacement and disconnect",
    async (kind) => {
      const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ available: false }));
      vi.stubGlobal("fetch", fetchMock);
      const view = mount(attachment(kind));
      await settle(view.container);
      const stale = observations.at(-1);
      expect(stale).toBeDefined();
      view.replace(attachment(kind));
      await settle(view.container);
      stale?.show();
      expect(fetchMock).not.toHaveBeenCalled();
      const current = observations.at(-1);
      render(null, view.container);
      current?.show();
      await settle(view.container);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
