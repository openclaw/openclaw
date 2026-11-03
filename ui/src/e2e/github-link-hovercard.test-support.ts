import path from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type {
  ControlUiLinkReaderDescriptor,
  ControlUiLinkReaderPreview,
} from "../../../src/shared/control-ui-link-reader.js";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { GITHUB_REPOSITORY_PLUGIN as GITHUB_REFERENCE_PLUGIN } from "../test-helpers/repository-plugin.ts";
import type { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

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

const GITHUB_REFERENCE_READER: ControlUiLinkReaderDescriptor = {
  pluginId: "github",
  id: "github",
  label: "GitHub",
  icon: "github",
  linkReader: {
    hosts: ["github.com"],
    pathPattern: "^/[^/]+/[^/]+/(?:issues/[1-9][0-9]{0,9}|pull/[1-9][0-9]{0,9}(?:/files)?)/?$",
    detailMethod: "github.detail",
    previewMethod: "github.preview",
    progressive: true,
  },
};

export async function expectText(locator: Locator, ...texts: string[]): Promise<void> {
  for (const text of texts) {
    await expect.poll(() => locator.textContent()).toContain(text);
  }
}

export async function expectAttr(locator: Locator, name: string, value: string | null) {
  expect(await locator.getAttribute(name)).toBe(value);
}

export async function expectPolledAttr(locator: Locator, name: string, value: string | null) {
  await expect.poll(() => locator.getAttribute(name)).toBe(value);
}

export const part = (card: Locator, name: string) =>
  card.locator(`.link-reader-hovercard__${name}`);

export const assistantMessage = (text: string, timestamp?: number) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  ...(timestamp === undefined ? {} : { timestamp }),
});

export function referencePreview(url: string, subtitle: string, title: string) {
  return {
    match: { url },
    response: { ...pullPreviewResponse, url, subtitle, title, author: "reviewer" },
  };
}

export function installReferencePreview(
  page: Page,
  options: Parameters<typeof installMockGateway>[1] = {},
) {
  return installMockGateway(page, {
    ...options,
    nativePlugins: options.nativePlugins ?? [GITHUB_REFERENCE_PLUGIN],
    controlUiLinkReaders: [GITHUB_REFERENCE_READER],
    featureMethods: [
      ...(options.featureMethods ?? defaultControlUiFeatureMethods),
      "github.preview",
      "github.detail",
      "plugins.controlUi.list",
      "plugins.controlUi.report",
    ],
  });
}
export function defineRepositoryReferenceTests(
  suite: ReturnType<typeof createControlUiE2eSuite>,
  newBrowserContext: () => Promise<BrowserContext>,
) {
  it("keeps explicit reference text literal without its contribution while authored links retain previews", async () => {
    const context = await newBrowserContext();
    const page = await context.newPage();
    const otherHref = "https://github.com/synthetic/other-project/pull/1576#issuecomment-1";
    const gateway = await installReferencePreview(page, {
      nativePlugins: [],
      historyMessages: [
        assistantMessage(
          [
            "Synthetic Gateway formatting example",
            "Plain: PR synthetic/formatting-demo#1576 opened.",
            "Formatted: PR **synthetic/formatting-demo#1576 opened**.",
            "Short reference: **PR** synthetic/formatting-demo#42 opened.",
            `Other repository: [#1576](${otherHref})`,
          ].join("\n\n"),
        ),
      ],
      methodResponses: {
        "github.preview": {
          cases: [
            referencePreview(
              otherHref,
              "synthetic/other-project #1576",
              "Separate repository example",
            ),
          ],
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await page.getByText("Synthetic Gateway formatting example", { exact: true }).waitFor();
    expect(await page.locator("strong a.markdown-github-item").count()).toBe(0);
    expect(await gateway.getRequests("projects.list")).toHaveLength(0);
    await page
      .locator(".chat-bubble")
      .filter({ hasText: "Synthetic Gateway formatting example" })
      .screenshot({
        path: path.join(suite.artifactDir, "github-reference-contribution-false.png"),
      });
    await page.locator(`a[href="${otherHref}"]`).focus();
    await expectText(page.locator(".link-reader-hovercard"), "Separate repository example");
  });
}
