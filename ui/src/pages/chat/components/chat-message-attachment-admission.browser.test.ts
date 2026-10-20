import { beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import "../../../styles.css";
import "../../../styles/chat.ts";
import { AssistantAttachments } from "./chat-message-attachments-solid.tsx";
import { releaseChatMediaResourceOwner, type AttachmentItem } from "./chat-message-media.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

const browserMode = "__vitest_browser__" in globalThis;
let userEvent: (typeof import("vitest/browser"))["userEvent"];
beforeAll(async () => {
  if (browserMode) {
    await import("../../../lib/chat/pasted-text-excerpt.ts");
    ({ userEvent } = await import("vitest/browser"));
  }
});

function admissionHarness(item: AttachmentItem, fetchMock: typeof fetch, withSidebar = false) {
  vi.stubGlobal("fetch", fetchMock);
  const onOpenSidebar = vi.fn<(content: SidebarContent) => void>();
  const scroller = document.body.appendChild(document.createElement("main"));
  scroller.style.cssText = "height:300px;overflow:auto;";
  const before = scroller.appendChild(document.createElement("button"));
  before.textContent = "Before attachment";
  const target = scroller.appendChild(document.createElement("section"));
  target.style.cssText = "margin-top:1200px;max-width:400px;";
  const after = scroller.appendChild(document.createElement("button"));
  after.textContent = "After attachment";
  const props = () => ({
    attachments: [item],
    options: { mediaOwner: update },
    onOpenSidebar: withSidebar ? onOpenSidebar : undefined,
    inlinePlayback: false,
  });
  const update = () => view.update(props());
  const view = mountSolid(AssistantAttachments, props(), target);
  return {
    scroller,
    before,
    target,
    after,
    onOpenSidebar,
    dispose() {
      view.dispose();
      scroller.remove();
      releaseChatMediaResourceOwner(update);
      vi.unstubAllGlobals();
    },
  };
}

const available = (mediaTicket: string) =>
  Response.json({
    available: true,
    mediaTicket,
    mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  });

describe.runIf(browserMode)("deferred attachment keyboard access", () => {
  it.each([true, false])(
    "retains native Tab focus while metadata loads with sidebar=%s",
    async (withSidebar) => {
      const metadata = createDeferred<Response>();
      const fetchMock = vi.fn<typeof fetch>(() => metadata.promise);
      const item: AttachmentItem = {
        type: "attachment",
        attachment: {
          kind: "document",
          label: "keyboard.pdf",
          url: `/tmp/openclaw/${crypto.randomUUID()}/keyboard.pdf`,
        },
      };
      const harness = admissionHarness(item, fetchMock, withSidebar);
      const { scroller, before, target, after, onOpenSidebar } = harness;
      try {
        expect(target.getBoundingClientRect().top).toBeGreaterThan(
          scroller.getBoundingClientRect().bottom + 240,
        );
        const link = target.querySelector<HTMLAnchorElement>("a[download]");
        expect(link).not.toBeNull();
        if (!link) {
          throw new Error("Missing deferred download");
        }
        expect(fetchMock).not.toHaveBeenCalled();
        before.focus();
        await userEvent.tab();
        await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
        expect(document.activeElement).toBe(link);
        expect(target.querySelector("a[download]")).toBe(link);
        expect(link.hasAttribute("href")).toBe(false);
        expect(link.getAttribute("aria-disabled")).toBe("true");
        const pageUrl = location.href;
        await userEvent.keyboard("{Enter}");
        expect(location.href).toBe(pageUrl);
        expect(onOpenSidebar).not.toHaveBeenCalled();
        metadata.resolve(available("keyboard"));
        await expect.poll(() => link.getAttribute("href")).toContain("mediaTicket=keyboard");
        expect(target.querySelector("a[download]")).toBe(link);
        expect(document.activeElement).toBe(link);
        expect(link.hasAttribute("aria-disabled")).toBe(false);
        await userEvent.tab();
        if (withSidebar) {
          expect(document.activeElement).toBe(
            target.querySelector(".chat-assistant-attachment-card__expand"),
          );
          await userEvent.keyboard("{Enter}");
          expect(onOpenSidebar).toHaveBeenCalledOnce();
        } else {
          expect(document.activeElement).toBe(after);
        }
      } finally {
        metadata.resolve(Response.json({ available: false }));
        harness.dispose();
      }
    },
  );
});

describe.runIf(browserMode)("history text chip keyboard admission", () => {
  it.each(["comment", "paste"] as const)(
    "retains native Tab focus through held %s metadata and body loading",
    async (kind) => {
      const metadata = createDeferred<Response>();
      const body =
        kind === "comment"
          ? "Selected text:\nhello\n\nSource session: agent:main:main\nDOM text UTF-16 range: [0, 5)"
          : "Visible pasted excerpt";
      const fetchMock = vi.fn<typeof fetch>((input) =>
        (typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url
        ).includes("meta=1")
          ? metadata.promise
          : Promise.resolve(new Response(body)),
      );
      const harness = admissionHarness(
        {
          type: "attachment",
          attachment: {
            kind: "document",
            label: kind === "comment" ? "selection-comment.txt" : "pasted-text-123.txt",
            mimeType: "text/plain",
            url: `/tmp/openclaw/${crypto.randomUUID()}/text-chip.txt`,
          },
        },
        fetchMock,
      );
      const { target, before, scroller } = harness;
      try {
        await expect
          .poll(() => target.querySelector(".chat-selection-annotations__chip"))
          .not.toBeNull();
        const chip = target.querySelector<HTMLElement>(".chat-selection-annotations__chip");
        if (!chip) {
          throw new Error("Missing history text chip");
        }
        expect(chip.getBoundingClientRect().top).toBeGreaterThan(
          scroller.getBoundingClientRect().bottom + 240,
        );
        expect(fetchMock).not.toHaveBeenCalled();
        before.focus();
        await userEvent.tab();
        await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
        expect(document.activeElement).toBe(chip);
        expect(target.querySelector(".chat-selection-annotations__chip")).toBe(chip);
        metadata.resolve(available("keyboard-chip"));
        await expect
          .poll(() => target.textContent)
          .toContain(kind === "comment" ? "hello" : "Visible pasted excerpt");
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(target.querySelector(".chat-selection-annotations__chip")).toBe(chip);
        expect(document.activeElement).toBe(chip);
      } finally {
        metadata.resolve(Response.json({ available: false }));
        harness.dispose();
      }
    },
  );
});
