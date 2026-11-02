import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../../../test/helpers/ui-style-fixtures.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../../../test-helpers/control-ui-e2e.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { CompactAttachmentCard } from "./chat-attachment-card-solid.tsx";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeDownloadVisibility = canRunPlaywrightChromium(chromiumExecutablePath)
  ? describe
  : describe.skip;

let browser: Browser;

async function restDownloadState(
  options: Parameters<typeof CompactAttachmentCard>[0],
): Promise<{ opacity: string; pointerEvents: string }> {
  const view = mountSolid(() => <CompactAttachmentCard {...options} />);
  flush();
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html>
      <html>
        <head><style>${readStyleSheet("ui/src/styles/chat/message-layout.css")}</style></head>
        <body><div class="chat-group-messages">${view.container.innerHTML}</div></body>
      </html>`);
    return await page.evaluate(() => {
      const download = document.querySelector<HTMLElement>(
        ".chat-assistant-attachment-card__download",
      )!;
      const style = getComputedStyle(download);
      return { opacity: style.opacity, pointerEvents: style.pointerEvents };
    });
  } finally {
    view.unmount();
    await page.close();
  }
}

describeDownloadVisibility("attachment download visibility", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  it("keeps a document download visible and clickable without hovering", async () => {
    expect(
      await restDownloadState({
        kind: "document",
        label: "bundle.zip",
        mimeType: "application/zip",
        sizeBytes: 1_572_864,
        downloadHref: "/api/chat/media/outgoing/agent%3Amain%3Amain/bundle.zip",
        onExpand: () => {},
      }),
    ).toEqual({ opacity: "1", pointerEvents: "auto" });
  });

  it("keeps media downloads hover-only when an expand action exists", async () => {
    expect(
      await restDownloadState({
        kind: "audio",
        label: "clip.mp3",
        mimeType: "audio/mpeg",
        downloadHref: "/api/chat/media/outgoing/agent%3Amain%3Amain/clip.mp3",
        onExpand: () => {},
      }),
    ).toEqual({ opacity: "0", pointerEvents: "none" });
  });
});
