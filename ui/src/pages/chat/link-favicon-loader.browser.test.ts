import { afterEach, expect, it, vi } from "vitest";
import "../../styles/chat/text.css";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { hydrateLinkFavicons, releaseLinkFavicons } from "./link-favicon-loader.ts";

let root: HTMLDivElement;

afterEach(() => {
  releaseLinkFavicons(root);
  root.remove();
});

function renderLink() {
  root = document.createElement("div");
  root.className = "chat-text";
  root.innerHTML = toSanitizedMarkdownHtml(
    "See the [Control UI startup lifecycle](https://docs.example.test/startup).",
    { linkFavicons: true },
  );
  document.body.append(root);
  return root.querySelector<HTMLImageElement>(".markdown-link-favicon")!;
}

it("reserves the loading slot, then displays the decoded favicon", async () => {
  const image = renderLink();
  let resolve!: (url: string) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  hydrateLinkFavicons(root, fetcher);
  await expect.poll(() => fetcher.mock.calls.length).toBe(1);
  expect(image.getBoundingClientRect().width).toBeGreaterThan(0);
  const url = URL.createObjectURL(
    new Blob(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#e34b31"/></svg>',
      ],
      { type: "image/svg+xml" },
    ),
  );
  resolve(url);
  await expect.poll(() => image.dataset.linkFaviconState).toBe("loaded");
  expect(image.naturalWidth).toBe(16);
  expect(image.getBoundingClientRect().width).toBeGreaterThan(0);
  expect(getComputedStyle(image).visibility).toBe("visible");
});

it("leaves no empty slot when the site has no usable favicon", async () => {
  const image = renderLink();
  hydrateLinkFavicons(root, async () => null);
  await expect.poll(() => image.dataset.linkFaviconState).toBe("failed");
  expect(image.getBoundingClientRect().width).toBe(0);
});
