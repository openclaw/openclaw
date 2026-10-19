import { readFileSync } from "node:fs";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  pauseVirtualClock,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { TEST_LINK_READER } from "../test-helpers/link-reader.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Link hover previews" });
const url = "https://example.com/field-guide";
const repositoryUrl = "https://github.com/openclaw/openclaw";
const pullUrl = `${repositoryUrl}/pull/42`;
const readerMethods = [...defaultControlUiFeatureMethods, "forge.preview", "forge.detail"];
const historyMessages = [
  { role: "user", content: "Can you share the guide and the project?", timestamp: 1000 },
  {
    role: "assistant",
    content:
      "Start with the [Field guide](https://example.com/field-guide) for a practical introduction.\n\nExplore the [OpenClaw repository](https://github.com/openclaw/openclaw). The [project update](https://github.com/openclaw/openclaw/pull/42) has the implementation details.\n\nYou can also read the [reference notes](https://example.org/notes).",
    timestamp: 2000,
  },
];
const preview = {
  title: "OpenClaw field guide",
  description:
    "A practical introduction to your personal assistant. Explore the guide, follow the examples, and make it your own.",
  imageDataUrl:
    "data:image/png;base64," +
    readFileSync("docs/assets/openclaw-hero-dark.png").toString("base64"),
  faviconDataUrl:
    "data:image/png;base64," + readFileSync("ui/public/favicon-32.png").toString("base64"),
};

async function assertBounds(card: Locator, width: number, height: number, checkLeft = true) {
  const bounds = (await card.boundingBox())!;
  if (checkLeft) {
    expect(bounds.x).toBeGreaterThanOrEqual(0);
  }
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
}
function hasGuideTooltip(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("openclaw-tooltip")].some(
      (element) => element.content === "Guide details",
    ),
  );
}

async function openPreviewPage(
  page: Page,
  options: Parameters<typeof installMockGateway>[1] = {},
  route = "chat",
) {
  const gateway = await installMockGateway(page, {
    automaticallyFetchFavicons: true,
    historyMessages,
    ...options,
  });
  await page.goto(suite.server.baseUrl + route);
  return gateway;
}
function fallbackCase(route: string, href: string, reader = false, input = "pointer") {
  return {
    route,
    routeId: route === "chat" ? "chat" : "about",
    selector: `${route === "chat" ? ".chat-group.assistant a" : "openclaw-about-page .about-hero__link"}[href="${href}"]`,
    reader,
    input,
  };
}
async function prepareFallbackLink(link: Locator) {
  await link.waitFor({ state: "visible" });
  await link.evaluate((anchor) => anchor.setAttribute("title", "Guide details"));
  expect(
    await link.evaluate(
      (anchor) =>
        getComputedStyle(anchor.closest("openclaw-link-reader-hovercard-provider")!).display,
    ),
  ).toBe("contents");
}
async function expectProviderUnloaded(page: Page) {
  expect(
    await page.evaluate(
      () => customElements.get("openclaw-link-reader-hovercard-provider") === undefined,
    ),
  ).toBe(true);
}
async function hoverPreview(link: Locator, card: Locator, title = preview.title, decode = false) {
  await link.hover();
  await card.getByText(title, { exact: true }).waitFor();
  if (decode) {
    await card
      .locator(".link-hovercard__image")
      .evaluate((image: HTMLImageElement) => image.decode());
  }
}

suite.define(() => {
  it("previews ordinary Web UI links on mobile", async () => {
    const width = 390;
    const height = 844;
    await suite.withPage(
      { viewport: { width, height }, colorScheme: "light" },
      async ({ page, context }) => {
        const directRequests: string[] = [];
        await context.route("https://example.com/**", async (route) => {
          directRequests.push(route.request().url());
          await route.fulfill({ contentType: "text/html", body: "<h1>Field guide</h1>" });
        });
        const gateway = await openPreviewPage(page, {
          controlUiLinkReaders: [TEST_LINK_READER],
          featureMethods: readerMethods,
          methodResponses: {
            "controlUi.linkPreview": {
              cases: [
                { match: { url }, response: preview },
                { match: { url: repositoryUrl }, response: preview },
                { match: { url: "https://example.org/notes" }, response: {} },
              ],
            },
            "forge.preview": {
              cases: [
                {
                  match: { url: pullUrl },
                  response: {
                    url: pullUrl,
                    title: "Custom GitHub preview",
                    createdAt: "2026-09-01T00:00:00Z",
                    updatedAt: "2026-09-02T00:00:00Z",
                  },
                },
              ],
            },
          },
        });
        const link = page.getByRole("link", { name: "Field guide", exact: true });
        await link.evaluate((element) => element.setAttribute("title", "Guide details"));
        await gateway.waitForRequest("forge.preview");
        expect(await gateway.getRequests("controlUi.linkPreview")).toEqual([]);
        const card = page.locator(".link-hovercard");
        await hoverPreview(link, card, preview.title, true);
        expect(await card.textContent()).toContain(preview.description);
        expect(await card.locator(".link-hovercard__identity img").count()).toBe(1);
        expect(await card.getAttribute("role")).toBe("dialog");
        expect(await hasGuideTooltip(page)).toBe(false);
        await assertBounds(card, width, height);
        expect(directRequests).toEqual([]);

        await card.hover();
        expect(await card.isVisible()).toBe(true);
        const opened = context.waitForEvent("page");
        await card.getByRole("link", { name: "Open in your browser" }).click();
        const destination = await opened;
        await destination.waitForURL(url);
        await destination.close();
        await page.bringToFront();
        expect(directRequests).toEqual([url]);
        await page.mouse.move(0, 0);
        await expect.poll(() => card.count()).toBe(0);
        await page.keyboard.press("Tab");
        await link.focus();
        await card.getByText(preview.title, { exact: true }).waitFor();
        await page.keyboard.press("Tab");
        expect(
          await card.locator("a").evaluate((element) => element === document.activeElement),
        ).toBe(true);
        await page.keyboard.press("Escape");
        expect(await card.count()).toBe(0);
        expect(await hasGuideTooltip(page)).toBe(false);
        expect(await link.evaluate((element) => element === document.activeElement)).toBe(true);
        const repository = page.getByRole("link", { name: "OpenClaw repository", exact: true });
        await hoverPreview(repository, card, preview.title, true);
        expect(await card.locator("a").getAttribute("href")).toBe(repositoryUrl);
        expect(await card.locator(".link-hovercard__identity").textContent()).toContain(
          "github.com",
        );
        await assertBounds(card, width, height);

        const github = page.getByRole("link", { name: "project update", exact: true });
        await github.hover();
        await page
          .locator(".link-reader-hovercard")
          .getByText("Custom GitHub preview", { exact: true })
          .waitFor();
        expect(await card.count()).toBe(0);
        await page.mouse.move(0, 0);
        await expect.poll(() => page.locator(".link-reader-hovercard").count()).toBe(0);
        const notes = page.getByRole("link", { name: "reference notes", exact: true });
        await hoverPreview(notes, card, "reference notes");
        expect(await card.locator("img").count()).toBe(0);

        expect(
          (await gateway.getRequests("controlUi.linkPreview")).map((request) => request.params),
        ).toEqual([{ url }, { url: repositoryUrl }, { url: "https://example.org/notes" }]);
        await page.mouse.move(0, 0);
        await expect.poll(() => card.count()).toBe(0);
        await gateway.setMethodResponse("controlUi.linkPreview", {
          ...preview,
          title: "A detailed field guide for everyday projects and shared workflows ".repeat(4),
          description: "Useful context with long words: " + "uninterrupted".repeat(40),
        });
        await notes.evaluate((anchor) => anchor.setAttribute("href", "https://example.org/long"));
        await notes.hover();
        await expect
          .poll(() => card.locator(".link-hovercard__title").textContent())
          .toContain("A detailed field guide");
        await assertBounds(card, width, height, false);
      },
    );
  });

  it.each([
    fallbackCase("settings/about", "https://docs.openclaw.ai"),
    fallbackCase("chat", url),
    fallbackCase("chat", pullUrl, true),
    fallbackCase("chat", pullUrl, true, "focus"),
  ])(
    "keeps $route $input title hints (reader: $reader) when the optional hover runtime cannot load",
    ({ route, routeId, selector, reader, input }) =>
      suite.withPage({}, async ({ page }) => {
        const hovercardModule = controlUiE2eBuiltModuleRequest(
          "ui/src/components/link-reader-hovercard.ts",
        );
        await page.route(hovercardModule, (request) => request.abort());
        const gateway = await openPreviewPage(
          page,
          {
            historyMessages: route === "chat" ? historyMessages : [],
            controlUiLinkReaders: reader ? [TEST_LINK_READER] : [],
            featureMethods: readerMethods,
          },
          route,
        );
        await waitForControlUiRoute(page, { routeId });
        const link = page.locator(selector);
        await prepareFallbackLink(link);
        await expectProviderUnloaded(page);
        // A missing hashed chunk reloads the page; wait before hovering the new document.
        await Promise.all([
          page.waitForEvent("requestfailed", (request) => hovercardModule.test(request.url())),
          page.waitForEvent("domcontentloaded"),
          link.hover(),
        ]);
        await waitForControlUiRoute(page, { routeId });
        await prepareFallbackLink(link);
        await page.mouse.move(0, 0);
        await link[input === "focus" ? "focus" : "hover"]();
        await page.locator(".tooltip-content").filter({ hasText: "Guide details" }).waitFor();
        expect(await page.locator(".link-hovercard").count()).toBe(0);
        expect(await gateway.getRequests("controlUi.linkPreview")).toEqual([]);
        expect(await gateway.getRequests("forge.preview")).toEqual([]);
      }),
  );

  it("preserves detail-only, internal, session, file and explicit external-panel links", () =>
    suite.withPage({}, async ({ page }) => {
      const commitUrl = "https://github.com/openclaw/openclaw/commit/" + "a".repeat(40);
      const gateway = await openPreviewPage(page, {
        historyMessages: [
          {
            role: "assistant",
            content:
              "[Guide](https://example.com/guide) [Commit](" +
              commitUrl +
              ") [Control](https://example.org/control)",
            timestamp: 2000,
          },
        ],
        controlUiLinkReaders: [
          {
            pluginId: "forge",
            id: "commits",
            label: "Commits",
            linkReader: {
              hosts: ["github.com"],
              pathPattern: "^/[^/]+/[^/]+/commit/[a-f0-9]+$",
              detailMethod: "forge.detail",
            },
          },
        ],
        featureMethods: [...defaultControlUiFeatureMethods, "forge.detail"],
        methodResponses: { "controlUi.linkPreview": preview },
      });
      const link = page.getByRole("link", { name: "Guide", exact: true });
      await link.waitFor();
      await page.clock.install();
      await pauseVirtualClock(page);
      await page.getByRole("link", { name: "Commit", exact: true }).hover();
      await page.clock.runFor(400);
      expect(await page.locator(".link-hovercard").count()).toBe(0);
      for (const marker of [
        "download",
        "data-session-href",
        "data-file-path",
        "data-link-reader-external",
      ]) {
        await link.evaluate((anchor, attribute) => anchor.setAttribute(attribute, "guide"), marker);
        await link.hover();
        await page.clock.runFor(400);
        expect(await page.locator(".link-hovercard").count()).toBe(0);
        await page.mouse.move(0, 0);
        await link.evaluate((anchor, attribute) => anchor.removeAttribute(attribute), marker);
      }
      await link.evaluate((anchor) => anchor.setAttribute("href", "/chat/main"));
      await link.hover();
      await page.clock.runFor(400);
      expect(await gateway.getRequests("controlUi.linkPreview")).toEqual([]);
      const control = page.getByRole("link", { name: "Control", exact: true });
      await expectProviderUnloaded(page);
      const originalControl = await control.elementHandle();
      await control.hover();
      // Wait for lazy activation before advancing the opening delay; do not move the pointer again.
      await page.evaluate(async () => {
        await customElements.whenDefined("openclaw-link-reader-hovercard-provider");
        await document.querySelector("openclaw-link-reader-hovercard-provider")?.updateComplete;
      });
      await page.clock.runFor(400);
      expect(
        await originalControl?.evaluate((anchor) => anchor.isConnected && anchor.matches(":hover")),
      ).toBe(true);
      expect(
        await control.evaluate((anchor, original) => anchor === original, originalControl),
      ).toBe(true);
      await page.locator(".link-hovercard").getByText(preview.title).waitFor();
      expect(
        (await gateway.getRequests("controlUi.linkPreview")).map((request) => request.params),
      ).toEqual([{ url: "https://example.org/control" }]);
    }));

  it("makes no metadata requests with the existing automatic-fetch setting off", () =>
    suite.withPage({}, async ({ page }) => {
      const gateway = await openPreviewPage(page, { automaticallyFetchFavicons: false });
      const link = page.getByRole("link", { name: "Field guide", exact: true });
      await link.hover();
      await page.keyboard.press("Tab");
      await link.focus();
      expect(await page.locator(".link-hovercard").count()).toBe(0);
      expect(await gateway.getRequests("controlUi.linkPreview")).toEqual([]);
    }));

  it("keeps touch taps as native link navigation without fetching previews", () =>
    suite.withPage(
      { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
      async ({ page, context }) => {
        await context.route("https://example.com/**", (route) =>
          route.fulfill({ body: "Field guide", contentType: "text/html" }),
        );
        const gateway = await openPreviewPage(page);
        const opened = context.waitForEvent("page");
        await page.getByRole("link", { name: "Field guide", exact: true }).tap();
        const destination = await opened;
        await destination.waitForURL(url);
        expect(await page.locator(".link-hovercard").count()).toBe(0);
        expect(await gateway.getRequests("controlUi.linkPreview")).toEqual([]);
        await destination.close();
      },
    ));
});
