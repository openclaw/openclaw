import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { mediaTicketPayload } from "../../../test-helpers/control-ui-attachment-fixtures.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import "../../../styles.css";
import "../../../styles/chat.ts";
import { AssistantAttachments } from "./chat-message-attachments-solid.tsx";
import { releaseChatMediaResourceOwner } from "./chat-message-media.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

const browserMode = "__vitest_browser__" in globalThis;
let userEvent: (typeof import("vitest/browser"))["userEvent"];
beforeAll(async () => {
  if (browserMode) {
    await import("../../../lib/chat/pasted-text-excerpt.ts");
    ({ userEvent } = await import("vitest/browser"));
  }
});

function admissionHarness(label: string, body?: string, withSidebar = false) {
  const metadata = createDeferred<Response>();
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return body === undefined || url.includes("meta=1") ? metadata.promise : new Response(body);
  });
  vi.stubGlobal("fetch", fetchMock);
  const onOpenSidebar = vi.fn<(content: SidebarContent) => void>();
  const scroller = document.body.appendChild(document.createElement("main"));
  scroller.style.cssText = "height:300px;overflow:auto;";
  const before = scroller.appendChild(document.createElement("button"));
  const target = scroller.appendChild(document.createElement("section"));
  target.style.cssText = "margin-top:1200px;max-width:400px;";
  const after = scroller.appendChild(document.createElement("button"));
  const attachments = [
    {
      type: "attachment" as const,
      attachment: {
        kind: "document" as const,
        label,
        ...(body === undefined ? {} : { mimeType: "text/plain" }),
        url: `/tmp/openclaw/${crypto.randomUUID()}/${body !== undefined ? "text-chip.txt" : label}`,
      },
    },
  ];
  const props = () => ({
    attachments,
    options: { mediaOwner: update },
    onOpenSidebar: withSidebar ? onOpenSidebar : undefined,
    inlinePlayback: false,
  });
  const update = () => view.update(props());
  const view = mountSolid(AssistantAttachments, props(), target);
  onTestFinished(() => {
    metadata.resolve(Response.json({ available: false }));
    view.dispose();
    scroller.remove();
    releaseChatMediaResourceOwner(update);
    vi.unstubAllGlobals();
  });
  return {
    target,
    after,
    onOpenSidebar,
    metadata,
    fetchMock,
    async admit(selector: string, wholeCard = false) {
      await expect.poll(() => target.querySelector(selector)).not.toBeNull();
      const element = expectDefined(target.querySelector<HTMLElement>(selector), selector);
      const bounds = wholeCard ? target : element;
      expect(bounds.getBoundingClientRect().top).toBeGreaterThan(
        scroller.getBoundingClientRect().bottom + 240,
      );
      expect(fetchMock).not.toHaveBeenCalled();
      before.focus();
      await userEvent.tab();
      await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
      this.expectRetained(element, selector);
      return element;
    },
    expectRetained(element: HTMLElement, selector: string) {
      expect(document.activeElement).toBe(element);
      expect(target.querySelector(selector)).toBe(element);
    },
  };
}

const available = (mediaTicket: string) => Response.json(mediaTicketPayload(mediaTicket, 300_000));

describe.runIf(browserMode)("attachment keyboard admission", () => {
  it.each([true, false])("retains Tab focus through metadata, sidebar=%s", async (withSidebar) => {
    const harness = admissionHarness("keyboard.pdf", undefined, withSidebar);
    const { target, after, onOpenSidebar, metadata } = harness;
    const download = await harness.admit("a[download]", true);
    expect(download.hasAttribute("href")).toBe(false);
    expect(download.getAttribute("aria-disabled")).toBe("true");
    const pageUrl = location.href;
    await userEvent.keyboard("{Enter}");
    expect(location.href).toBe(pageUrl);
    expect(onOpenSidebar).not.toHaveBeenCalled();
    metadata.resolve(available("keyboard"));
    await expect.poll(() => download.getAttribute("href")).toContain("mediaTicket=keyboard");
    harness.expectRetained(download, "a[download]");
    expect(download.hasAttribute("aria-disabled")).toBe(false);
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
  });
  it.each([
    [
      "selection-comment.txt",
      "Selected text:\nhello\n\nSource session: agent:main:main\nDOM text UTF-16 range: [0, 5)",
      "hello",
    ],
    ["pasted-text-123.txt", "Visible pasted excerpt", "Visible pasted excerpt"],
  ])("retains Tab focus through %s text loading", async (label, body, excerpt) => {
    const harness = admissionHarness(label, body);
    const { target, metadata, fetchMock } = harness;
    const textChip = await harness.admit(".chat-selection-annotations__chip");
    metadata.resolve(available("keyboard-chip"));
    await expect.poll(() => target.textContent).toContain(excerpt);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    harness.expectRetained(textChip, ".chat-selection-annotations__chip");
  });
});
