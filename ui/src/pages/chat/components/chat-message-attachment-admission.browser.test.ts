import { render } from "lit";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import "../../../styles.css";
import "../../../styles/chat.ts";
import { renderAssistantAttachments } from "./chat-message-attachments.ts";
import { releaseChatMediaResourceSubscriber, type AttachmentItem } from "./chat-message-media.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

const browserMode = "__vitest_browser__" in globalThis;
let userEvent: (typeof import("vitest/browser"))["userEvent"];
beforeAll(async () => {
  if (browserMode) {
    ({ userEvent } = await import("vitest/browser"));
  }
});

describe.runIf(browserMode)("deferred attachment keyboard access", () => {
  it.each([true, false])(
    "retains native Tab focus while metadata loads with sidebar=%s",
    async (withSidebar) => {
      const metadata = createDeferred<Response>();
      const fetchMock = vi.fn<typeof fetch>(() => metadata.promise);
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
      const item: AttachmentItem = {
        type: "attachment",
        attachment: {
          kind: "document",
          label: "keyboard.pdf",
          url: `/tmp/openclaw/${crypto.randomUUID()}/keyboard.pdf`,
        },
      };
      const update = () =>
        render(
          renderAssistantAttachments(
            [item],
            { onRequestUpdate: update },
            withSidebar ? onOpenSidebar : undefined,
            undefined,
            false,
          ),
          target,
        );
      try {
        update();
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
        metadata.resolve(
          Response.json({
            available: true,
            mediaTicket: "keyboard",
            mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
          }),
        );
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
        render(null, target);
        scroller.remove();
        releaseChatMediaResourceSubscriber(update);
        vi.unstubAllGlobals();
      }
    },
  );
});
