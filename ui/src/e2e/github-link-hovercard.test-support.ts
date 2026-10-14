import type { Page } from "playwright";
import { expect } from "vitest";
import type { ControlUiLinkReaderPreview } from "../../../src/shared/control-ui-link-reader.js";

export const pullPreviewResponse = {
  url: "https://github.com/openclaw/openclaw/pull/99816",
  subtitle: "openclaw/openclaw #99816",
  author: "steipete",
  authorUrl: "https://github.com/steipete",
  coAuthors: ["ada", "mira", "lin"].map((name) => ({
    name,
    imageUrl:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlY9Z8AAAAASUVORK5CYII=",
  })),
  coAuthorCount: 5,
  badge: { label: "Merged", tone: "accent" },
  metadata: [
    { label: "", value: "+101", tone: "positive" },
    { label: "", value: "−12", tone: "negative" },
  ],
  imageUrl:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlY9Z8AAAAASUVORK5CYII=",
  createdAt: "2026-07-04T05:03:47Z",
  title: "fix(agents): derive conversation scope from trusted group facts",
  updatedAt: "2026-07-04T09:53:55Z",
} satisfies ControlUiLinkReaderPreview;

export const PULL_HREF = "https://github.com/openclaw/openclaw/pull/99816";
export const PULL_COMMENT_HREF = `${PULL_HREF}#issuecomment-123`;

// Headless Chromium suppresses modifier-opened windows even for plain anchors.
// Observe the browser handoff after application handlers, then suppress navigation.
export async function expectModifiedNavigation(
  page: Page,
  activate: () => Promise<void>,
  href: string,
) {
  await page.evaluate(() => {
    window.addEventListener(
      "click",
      (event) => {
        const anchor = event
          .composedPath()
          .find((target): target is HTMLAnchorElement => target instanceof HTMLAnchorElement);
        document.body.setAttribute(
          "data-native-navigation",
          JSON.stringify({
            href: anchor?.href,
            shift: event.shiftKey,
            prevented: event.defaultPrevented,
          }),
        );
        event.preventDefault();
      },
      { once: true },
    );
  });
  await activate();
  expect(
    JSON.parse((await page.locator("body").getAttribute("data-native-navigation")) ?? "null"),
  ).toEqual({ href, shift: true, prevented: false });
}
