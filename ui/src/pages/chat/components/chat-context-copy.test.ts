/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { prepareChatMessageRender, resolveMessageActionDetails } from "./chat-message-markdown.ts";
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

  it.each(["user", "assistant"])(
    "copies %s source without a footer or reply callback",
    async (role) => {
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
    },
  );

  it("copies selected text in tool output without message actions", async () => {
    owner.innerHTML = '<div class="chat-tool-msg-body">selected output</div>';
    const target = owner.firstElementChild!;
    const range = document.createRange();
    range.selectNodeContents(target);
    window.getSelection()!.addRange(range);
    open(target);
    await copy("Copy", "selected output");
  });

  it.each(["document", "audio", "video"])(
    "copies the %s card download link, not playback state",
    async (kind) => {
      owner.innerHTML = `<div class="chat-assistant-attachment-card chat-assistant-attachment-card--${kind}">
      <span class="chat-assistant-attachment-card__title">report</span>
      <a class="chat-assistant-attachment-card__download" href="https://example.test/report">Download</a>
      <video src="blob:temporary-playback"></video>
    </div>`;
      open(owner.querySelector("span")!);
      await copy("Copy link", "https://example.test/report");
    },
  );

  it("copies a file name without inventing a link for a pending attachment", async () => {
    owner.innerHTML =
      '<div class="chat-assistant-attachment-card"><span class="chat-assistant-attachment-card__title">report.pdf</span><a class="chat-assistant-attachment-card__download" aria-disabled="true">Download</a></div>';
    open(owner.querySelector("span")!);
    await copy("Copy file name", "report.pdf");
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
