/* @vitest-environment jsdom */
import { createComponent, createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { AttachmentStateCard, CompactAttachmentCard } from "./chat-attachment-card-solid.tsx";
import type { AttachmentCardHeaderOptions } from "./chat-attachment-card.ts";
import { CompactAttachmentFile } from "./chat-attachment-file.tsx";
import { AttachmentPreviewChip } from "./chat-attachment-preview-chip.tsx";
import { AssistantAttachmentStatusCard } from "./chat-message-attachment-status-solid.tsx";
import {
  prepareChatMessageRender,
  resolveMessageActionDetails,
} from "./chat-message-markdown-view.tsx";
import {
  handleTranscriptContextMenu,
  resetThreadPresentation,
} from "./chat-thread-interactions.ts";

describe("chat content context copy", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  let owner: HTMLElement;

  beforeEach(() => {
    writeText.mockClear();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    owner = document.createElement("section");
    owner.addEventListener("contextmenu", (event) =>
      handleTranscriptContextMenu(event, { paneId: "copy-test", onSetReply: vi.fn() }),
    );
    document.body.append(owner);
  });
  afterEach(() => {
    cleanupSolid();
    window.getSelection()?.removeAllRanges();
    resetThreadPresentation("copy-test");
    owner.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  function open(target: Element) {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }
  async function copy(label: string, expected: string) {
    const button = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (item) => item.textContent === label,
    );
    expect(button, label).toBeDefined();
    button!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith(expected));
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
  }

  it("copies complete code, not its chrome or collapsed preview", async () => {
    const code = "  <tag>\n\tline\n" + "more\n".repeat(8);
    owner.innerHTML = toSanitizedMarkdownHtml("```xml\n" + code + "```", {
      codeBlockInteraction: "interactive",
    });
    expect(open(owner.querySelector("code")!).defaultPrevented).toBe(true);
    await copy("Copy code", code.slice(0, -1));
  });

  it("copies a table as tab-separated cells, including outside a message bubble", async () => {
    owner.innerHTML = toSanitizedMarkdownHtml(
      "| Name | Count |\n| --- | --- |\n| **Alpha** | 2 |",
      {
        tableInteractions: "enabled",
      },
    );
    open(owner.querySelector("td strong")!);
    await copy("Copy table", "Name\tCount\nAlpha\t2");
  });

  it("copies source without a footer or reply callback", async () => {
    const role = "assistant";
    const source = "**Exact source** " + "x".repeat(520);
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    Object.assign(bubble, {
      messageActions: resolveMessageActionDetails(
        prepareChatMessageRender({ role, content: source }),
        {
          messageId: "commentary",
          senderLabel: role,
        },
      ),
    });
    owner.append(bubble);
    open(bubble);
    await copy("Copy as markdown", source);
  });

  it("copies selected text in tool output without message actions", async () => {
    owner.innerHTML = '<div class="chat-tool-msg-body">selected output</div>';
    const target = owner.firstElementChild!;
    const range = document.createRange();
    range.selectNodeContents(target);
    window.getSelection()!.addRange(range);
    open(target);
    await copy("Copy", "selected output");
  });

  function renderCard(props: AttachmentCardHeaderOptions) {
    mountSolid(() => createComponent(CompactAttachmentCard, props), { container: owner });
    return owner.firstElementChild!;
  }

  it("copies the admitted card link from the card surface, not playback state", async () => {
    const card = renderCard({
      kind: "video",
      label: "report",
      downloadHref: "/report",
    });
    const video = document.createElement("video");
    video.src = "blob:temporary-playback";
    card.append(video);
    open(card);
    await copy("Copy link", new URL("/report", document.baseURI).href);
  });

  it("reads current name and admitted href after a pending card updates", async () => {
    type Card = { name: string; href: string; pending: boolean };
    let update = (_next: Card) => {};
    mountSolid(
      () => {
        const [card, setCard] = createSignal<Card>({
          name: "report.pdf",
          href: "/not-admitted-yet",
          pending: true,
        });
        update = (next) => setCard(next);
        return createComponent(CompactAttachmentCard, {
          kind: "document",
          get label() {
            return card().name;
          },
          get downloadHref() {
            return card().href;
          },
          get downloadPending() {
            return card().pending;
          },
        });
      },
      { container: owner },
    );
    const card = owner.firstElementChild!;
    open(card);
    await copy("Copy file name", "report.pdf");

    update({ name: "renamed.pdf", href: "/current-ticket", pending: true });
    flush();
    open(card);
    await copy("Copy file name", "renamed.pdf");

    update({ name: "renamed.pdf", href: "/current-ticket", pending: false });
    flush();
    expect(owner.firstElementChild).toBe(card);
    open(card);
    await copy("Copy link", new URL("/current-ticket", document.baseURI).href);
  });

  it.each([false, true])("keeps callback downloads name-only while pending=%s", async (pending) => {
    const card = renderCard({
      kind: "document",
      label: "report.pdf",
      downloadHref: "/unused-link",
      downloadPending: pending,
      onDownload: vi.fn(),
    });
    open(card);
    await copy("Copy file name", "report.pdf");
  });

  it.each([false, true])("copies sidebar image state with pending=%s", async (pending) => {
    mountSolid(
      () =>
        createComponent(AttachmentStateCard, {
          kind: "image",
          label: "diagram.png",
          imagePreview: true,
          downloadHref: "/diagram.png",
          downloadPending: pending,
        }),
      { container: owner },
    );
    open(owner.firstElementChild!);
    await copy(
      pending ? "Copy file name" : "Copy link",
      pending ? "diagram.png" : new URL("/diagram.png", document.baseURI).href,
    );
  });

  it("copies an unavailable card's displayed name", async () => {
    mountSolid(
      () =>
        createComponent(AssistantAttachmentStatusCard, {
          label: "report.pdf",
          badge: "Unavailable",
          reason: "Retry later",
          path: "/private/source/report.pdf",
        }),
      { container: owner },
    );
    open(owner.firstElementChild!);
    await copy("Copy file name", "report.pdf");
  });

  it("copies a compact file's displayed label", async () => {
    mountSolid(
      () =>
        createComponent(CompactAttachmentFile, {
          attachment: { id: "copy-file", mimeType: "text/plain", fileName: "original.txt" },
          label: "Displayed excerpt",
        }),
      { container: owner },
    );
    open(owner.querySelector(".chat-attachment-file")!);
    await copy("Copy file name", "Displayed excerpt");
  });

  it("leaves preview chips without a copy payload", () => {
    mountSolid(
      () =>
        createComponent(AttachmentPreviewChip, {
          label: "Preview excerpt",
          icon: undefined,
        }),
      { container: owner },
    );
    expect(open(owner.querySelector(".chat-attachment-file")!).defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it.each([
    '<a href="https://example.test"><span>link</span></a>',
    '<button><img src="/image.png"></button>',
    '<video controls src="/video.mp4"></video>',
    '<audio controls src="/audio.mp3"></audio>',
    "<textarea>editable</textarea>",
    '<input value="editable">',
    '<div contenteditable="true"><span>editable</span></div>',
    '<div contenteditable="plaintext-only"><span>editable</span></div>',
    '<iframe src="about:blank"></iframe>',
  ])("preserves native copy and editing actions for %s", (markup) => {
    owner.innerHTML = `<div class="chat-group user"><div class="chat-bubble">${markup}</div></div>`;
    const bubble = owner.querySelector(".chat-bubble")!;
    Object.assign(bubble, {
      messageActions: {
        copyMarkdown: "source",
        replyTarget: { messageId: "message-1", text: "source" },
      },
    });
    const target = bubble.querySelector("span, img, video, audio, textarea, input, iframe")!;
    expect(open(target).defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("keeps failed copy visible and allows another attempt", async () => {
    writeText.mockRejectedValueOnce(new Error("clipboard denied"));
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => false),
    });
    owner.innerHTML = "<pre><code>literal tool output</code></pre>";
    open(owner.querySelector("code")!);
    document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
    await vi.waitFor(() =>
      expect(document.querySelector('[role="menuitem"]')?.textContent).toBe("Copy failed"),
    );
    await copy("Copy failed", "literal tool output");
    Reflect.deleteProperty(document, "execCommand");
  });
});
