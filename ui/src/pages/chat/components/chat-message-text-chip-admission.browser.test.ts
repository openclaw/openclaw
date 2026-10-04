import { render } from "lit";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import "../../../styles.css";
import "../../../styles/chat.ts";
import { renderAssistantAttachments } from "./chat-message-attachments.ts";
import { releaseChatMediaResourceSubscriber, type AttachmentItem } from "./chat-message-media.ts";

const browserMode = "__vitest_browser__" in globalThis;
let userEvent: (typeof import("vitest/browser"))["userEvent"];
beforeAll(async () => {
  if (browserMode) {
    ({ userEvent } = await import("vitest/browser"));
  }
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
      vi.stubGlobal("fetch", fetchMock);
      const scroller = document.body.appendChild(document.createElement("main"));
      scroller.style.cssText = "height:300px;overflow:auto;";
      const before = scroller.appendChild(document.createElement("button"));
      before.textContent = "Before text chip";
      const target = scroller.appendChild(document.createElement("section"));
      target.style.cssText = "margin-top:1200px;max-width:400px;";
      const item: AttachmentItem = {
        type: "attachment",
        attachment: {
          kind: "document",
          label: kind === "comment" ? "selection-comment.txt" : "pasted-text-123.txt",
          mimeType: "text/plain",
          url: `/tmp/openclaw/${crypto.randomUUID()}/text-chip.txt`,
        },
      };
      const update = () =>
        render(
          renderAssistantAttachments(
            [item],
            { onRequestUpdate: update },
            undefined,
            undefined,
            false,
          ),
          target,
        );
      try {
        update();
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
        metadata.resolve(
          Response.json({
            available: true,
            mediaTicket: "keyboard-chip",
            mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
          }),
        );
        await expect
          .poll(() => target.textContent)
          .toContain(kind === "comment" ? "hello" : "Visible pasted excerpt");
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(target.querySelector(".chat-selection-annotations__chip")).toBe(chip);
        expect(document.activeElement).toBe(chip);
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
