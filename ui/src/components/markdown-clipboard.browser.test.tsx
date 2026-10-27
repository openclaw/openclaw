import { createSignal, flush } from "solid-js";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { BrowserTabCardHost } from "../pages/chat/components/browser-tab-card.tsx";
import { MessageImages } from "../pages/chat/components/chat-message-images-view.tsx";
import {
  MessageMarkdown,
  type MessageMarkdownProps,
} from "../pages/chat/components/chat-message-text-view.tsx";
import { exportWidget } from "../pages/chat/components/widget-export.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { restorePropertyDescriptor } from "../test-helpers/property-descriptor.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import "./markdown-mermaid.tsx";
import { handleMarkdownCodeBlockClick } from "./markdown-code-blocks.ts";
import { handleMarkdownTableInteraction, releaseMarkdownTables } from "./markdown-tables.ts";
import { CopyButton } from "./solid/copy-button.tsx";

const owners: HTMLElement[] = [];
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
let clipboard = "original clipboard";
const writeText = vi.fn<(text: string) => Promise<void>>();
const fallbackCopies: string[] = [];
const selectors = { code: ".code-block-copy", table: ".markdown-table__copy" };

function expectClipboard(text: string, fallback: string[] = []) {
  expect(clipboard).toBe(text);
  expect(fallbackCopies).toEqual(fallback);
}

beforeEach(() => {
  clipboard = "original clipboard";
  fallbackCopies.length = 0;
  writeText.mockReset().mockImplementation(async (text) => {
    clipboard = text;
  });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  // Both transports stay inside this page; these tests never write the OS clipboard.
  vi.spyOn(document, "execCommand").mockImplementation(() => {
    const input = document.activeElement;
    if (!(input instanceof HTMLTextAreaElement)) {
      throw new Error("Clipboard fallback did not select its text");
    }
    clipboard = input.value;
    fallbackCopies.push(clipboard);
    return true;
  });
});

afterEach(() => {
  for (const owner of owners) {
    releaseMarkdownTables(owner);
  }
  cleanupSolid();
  for (const owner of owners.splice(0)) {
    owner.remove();
  }
  vi.restoreAllMocks();
  restorePropertyDescriptor(navigator, "clipboard", clipboardDescriptor);
});

afterAll(() => {
  window.dispatchEvent(new PageTransitionEvent("pagehide"));
});

async function waitForDiagram(diagram: HTMLElement) {
  const { page } = await import("vitest/browser");
  await expect.element(page.getByRole("img", { name: "Mermaid diagram" })).toBeVisible();
  await diagram.querySelector("img")!.decode();
}

async function mountCopy(surface: "code" | "table" | "mermaid" | "message") {
  const owner = document.body.appendChild(document.createElement("section"));
  owners.push(owner);
  owner.className = "chat-text";
  const [markdown, setMarkdown] = createSignal<MessageMarkdownProps>({
    markdown: surface === "code" ? "```ts\nconst answer = 42;" : "| Name |\n| --- |\n| Alpha",
    messageKey: "stream",
    options: { role: "assistant", isStreaming: true },
    markdownOptions: surface === "table" ? { tableInteractions: "enabled" } : {},
  });
  let button: HTMLButtonElement | null;
  if (surface === "code" || surface === "table") {
    mountSolid(() => <MessageMarkdown {...markdown()} />, { container: owner });
    flush();
    owner.addEventListener(
      "click",
      surface === "code" ? handleMarkdownCodeBlockClick : handleMarkdownTableInteraction,
    );
    button = owner.querySelector(selectors[surface]);
  } else if (surface === "mermaid") {
    const diagram = document.createElement("openclaw-mermaid");
    diagram.source = "flowchart LR\nA --> B";
    owner.append(diagram);
    await diagram.updateComplete;
    await waitForDiagram(diagram);
    button = diagram.querySelector(".copy-button");
  } else {
    mountSolid(() => <CopyButton text="Current message" bare />, { container: owner });
    flush();
    button = owner.querySelector("button");
  }
  if (!button) {
    throw new Error(`Missing ${surface} copy control`);
  }
  return { owner, button, setMarkdown };
}

function delayFirstWrite() {
  const pending = createDeferred();
  writeText.mockReturnValueOnce(pending.promise);
  return pending;
}

async function mountBrowserCard() {
  const [url, setUrl] = createSignal("https://example.com/document");
  const view = mountSolid(() => (
    <BrowserTabCardHost
      preview={{
        kind: "browser-tab",
        target: "host",
        profile: "managed",
        targetId: "clipboard-tab",
        url: url(),
      }}
    />
  ));
  flush();
  const card = view.container.querySelector<HTMLElement>("openclaw-browser-tab-card")!;
  owners.push(card);
  return {
    unmount: view.unmount,
    setUrl,
    copy: async () => {
      card.querySelector<HTMLButtonElement>(".more")!.click();
      const menu = card.querySelector<HTMLElement>(".oc-menu")!;
      await waitForSolid(() => expect(menu.matches(":popover-open")).toBe(true));
      card.querySelector<HTMLButtonElement>('[data-value="copy-url"]')!.click();
      await waitForSolid(() => expect(menu.matches(":popover-open")).toBe(false));
    },
  };
}

async function flushCopy() {
  // Clipboard handlers update after the transport's rejection/fallback microtasks.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function rejectCopy(pending: ReturnType<typeof delayFirstWrite>) {
  pending.reject(new Error("Synthetic clipboard rejection"));
  await flushCopy();
}

describe("Markdown clipboard operation lifetime", () => {
  it.each(
    ["managed image", "widget"].flatMap((surface) =>
      [true, false].map((available) => ({ surface, available })),
    ),
  )(
    "retires text fallback after $surface copy intent (binary API: $available)",
    async ({ surface, available }) => {
      const pendingText = delayFirstWrite();
      const pngData =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR7sAAAAASUVORK5CYII=";
      const nativeFetch = globalThis.fetch.bind(globalThis);
      const png = await (await nativeFetch(pngData)).blob();
      const snapshot = createDeferred<string>();
      const fullImage = createDeferred<Response>();
      const write = vi.fn(async (items: ClipboardItem[]) => {
        expect((await items[0]!.getType("image/png")).type).toBe("image/png");
        clipboard = "new binary image";
      });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText, ...(available ? { write } : {}) },
      });
      let copy: () => void | Promise<void>;
      let widgetResult: Promise<unknown> | undefined;
      if (surface === "managed image") {
        vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          return url.includes("/thumbnail")
            ? Promise.resolve(new Response(png))
            : url.includes("/full")
              ? fullImage.promise
              : nativeFetch(input, init);
        });
        const owner = document.body.appendChild(document.createElement("section"));
        owners.push(owner);
        mountSolid(
          () => (
            <MessageImages
              images={[
                {
                  url: `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`,
                  alt: "Synthetic image",
                },
              ]}
            />
          ),
          { container: owner },
        );
        await waitForSolid(() => expect(owner.querySelector(".chat-image-action")).not.toBeNull());
        copy = async () => {
          owner
            .querySelector<HTMLButtonElement>(
              '.chat-image-actions button[aria-label="Copy image"]',
            )!
            .click();
        };
      } else {
        const frame = document.body.appendChild(document.createElement("iframe"));
        owners.push(frame);
        vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((request) => {
          void snapshot.promise.then((dataUrl) => {
            window.dispatchEvent(
              new MessageEvent("message", {
                source: frame.contentWindow,
                data: { type: "openclaw:widget-snapshot", id: request.id, dataUrl },
              }),
            );
          });
        });
        copy = () => {
          widgetResult = exportWidget("copy", frame, "Synthetic widget").catch(
            (error: unknown) => error,
          );
        };
      }
      const code = await mountCopy("code");
      code.button.click();
      await copy();
      // Binary ClipboardItem promises must be submitted during the click, before bytes arrive.
      expect(write).toHaveBeenCalledTimes(available ? 1 : 0);
      await rejectCopy(pendingText);
      snapshot.resolve(pngData);
      fullImage.resolve(new Response(png));
      await widgetResult;
      if (available) {
        await vi.waitFor(() => expect(clipboard).toBe("new binary image"));
      }
      expect(fallbackCopies).toEqual([]);
    },
  );

  it("copies browser-card URLs when the Clipboard API is absent on plain HTTP", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const browser = await mountBrowserCard();
    await browser.copy();
    await flushCopy();
    expectClipboard("https://example.com/document", ["https://example.com/document"]);
  });

  it("keeps a newer browser URL copy when older code copying rejects", async () => {
    const pending = delayFirstWrite();
    const code = await mountCopy("code");
    const browser = await mountBrowserCard();
    code.button.click();
    await browser.copy();
    await flushCopy();
    expect(clipboard).toBe("https://example.com/document");
    await rejectCopy(pending);
    expectClipboard("https://example.com/document");
  });

  it.each(["removed", "URL changed"])(
    "retires browser URL copying after its card is %s",
    async (change) => {
      const pending = delayFirstWrite();
      const browser = await mountBrowserCard();
      await browser.copy();
      if (change === "removed") {
        browser.unmount();
      } else {
        browser.setUrl("https://example.com/new");
        flush();
      }
      await rejectCopy(pending);
      expect(fallbackCopies).toEqual([]);
    },
  );

  it.each(["code", "table", "mermaid", "message"] as const)(
    "does not start fallback after the %s control is retired",
    async (surface) => {
      const pending = delayFirstWrite();
      const { owner, button } = await mountCopy(surface);
      button.click();
      expect(writeText).toHaveBeenCalledOnce();
      owner.remove();
      await rejectCopy(pending);
      expectClipboard("original clipboard");
    },
  );

  it("preserves the newer copy when an older connected code control rejects", async () => {
    const pending = delayFirstWrite();
    const older = await mountCopy("code");
    const newer = await mountCopy("message");
    older.button.click();
    newer.button.click();
    await flushCopy();
    expect(clipboard).toBe("Current message");
    expect(older.button.isConnected).toBe(true);
    await rejectCopy(pending);
    expectClipboard("Current message");
  });

  it.each(
    (["code", "table"] as const).flatMap((surface) =>
      (["resolve", "reject"] as const).map((settlement) => ({ surface, settlement })),
    ),
  )(
    "retires stale $surface copying after pending write settlement: $settlement",
    async ({ surface, settlement }) => {
      const pending = delayFirstWrite();
      const { owner, button, setMarkdown } = await mountCopy(surface);
      const idleLabel = button.getAttribute("aria-label");
      button.click();
      setMarkdown({
        markdown:
          surface === "code"
            ? "```ts\nconst answer = 42;\nconst next = 43;"
            : "| Name |\n| --- |\n| Alpha continued |",
        messageKey: "stream",
        options: { role: "assistant", isStreaming: true },
        markdownOptions: { tableInteractions: "enabled" },
      });
      flush();
      expect(owner.querySelector(selectors[surface])).toBe(button);
      expect(button.isConnected).toBe(true);
      expect(owner.textContent).toContain(
        surface === "code" ? "const next = 43;" : "Alpha continued",
      );
      if (settlement === "reject") {
        pending.reject(new Error("Synthetic clipboard rejection"));
      } else {
        pending.resolve();
      }
      await flushCopy();
      expectClipboard("original clipboard");
      expect(button.getAttribute("aria-label")).toBe(idleLabel);
    },
  );

  it("retires an older fallback when the newer code-copy payload is empty", async () => {
    const pending = delayFirstWrite();
    const older = await mountCopy("code");
    const newer = await mountCopy("code");
    newer.setMarkdown({
      markdown: "```ts\n```",
      messageKey: "empty",
      options: { role: "assistant", isStreaming: false },
      markdownOptions: {},
    });
    flush();
    older.button.click();
    newer.owner.querySelector<HTMLButtonElement>(".code-block-copy")!.click();
    expect(writeText).toHaveBeenCalledOnce();
    await rejectCopy(pending);
    expectClipboard("original clipboard");
  });

  it("retires a Mermaid copy when its source changes on the connected element", async () => {
    const pending = delayFirstWrite();
    const { owner, button } = await mountCopy("mermaid");
    const diagram = owner.querySelector("openclaw-mermaid")!;
    button.click();
    diagram.source = "flowchart LR\nC --> D";
    await diagram.updateComplete;
    expect(diagram.isConnected).toBe(true);
    await rejectCopy(pending);
    expect(fallbackCopies).toEqual([]);
    await waitForDiagram(diagram);
  });

  it("keeps the newer table-copy feedback when an older request rejects", async () => {
    const pending = delayFirstWrite();
    const { button } = await mountCopy("table");
    button.click();
    button.click();
    await flushCopy();
    expect(button.getAttribute("aria-label")).toBe("Copied!");
    await rejectCopy(pending);
    expect(fallbackCopies).toEqual([]);
    expect(button.getAttribute("aria-label")).toBe("Copied!");
  });

  it.each(["code", "table", "mermaid", "message"] as const)(
    "keeps fallback available for the current %s control",
    async (surface) => {
      writeText.mockRejectedValueOnce(new Error("Synthetic clipboard rejection"));
      const { button } = await mountCopy(surface);
      button.click();
      await flushCopy();
      expect(fallbackCopies).toEqual([writeText.mock.calls[0]![0]]);
      expect(button.getAttribute("aria-label")).toBe("Copied!");
    },
  );
});
