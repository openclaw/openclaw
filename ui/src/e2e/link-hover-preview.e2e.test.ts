import { readFileSync } from "node:fs";
import path from "node:path";
import { PhotonImage, resize, SamplingFilter, watermark } from "@silvia-odwyer/photon-node";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { TEST_LINK_READER } from "../test-helpers/link-reader.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Link hover previews" });
const url = "https://example.com/field-guide";
const repositoryUrl = "https://github.com/openclaw/openclaw";
const historyMessages = [
  { role: "user", content: "Can you share the guide and the project?", timestamp: 1000 },
  {
    role: "assistant",
    content:
      "Start with the [Field guide](https://example.com/field-guide) for a practical introduction.\n\nExplore the [OpenClaw repository](https://github.com/openclaw/openclaw). The [project update](https://github.com/openclaw/openclaw/pull/42) has the implementation details.\n\nYou can also read the [reference notes](https://example.org/notes).",
    timestamp: 2000,
  },
];
function socialImage() {
  const canvas = new PhotonImage(
    Buffer.alloc(640 * 336 * 4, Buffer.from([11, 16, 22, 255])),
    640,
    336,
  );
  const source = PhotonImage.new_from_byteslice(readFileSync("docs/assets/openclaw-hero-dark.png"));
  const logo = resize(source, 566, 201, SamplingFilter.Lanczos3);
  try {
    watermark(canvas, logo, 37n, 67n);
    return "data:image/png;base64," + Buffer.from(canvas.get_bytes()).toString("base64");
  } finally {
    logo.free();
    source.free();
    canvas.free();
  }
}
const preview = {
  title: "OpenClaw field guide",
  description:
    "A practical introduction to your personal assistant. Explore the guide, follow the examples, and make it your own.",
  imageDataUrl: socialImage(),
  faviconDataUrl:
    "data:image/png;base64," + readFileSync("ui/public/favicon-32.png").toString("base64"),
};

suite.define(() => {
  it.each([
    { name: "desktop-dark", width: 1280, height: 900, colorScheme: "dark" as const },
    { name: "mobile-light", width: 390, height: 844, colorScheme: "light" as const },
  ])("previews ordinary Web UI links ($name)", async ({ name, width, height, colorScheme }) => {
    const artifacts = createControlUiE2eArtifactDir("link-hover-after-" + name);
    await suite.withPage(
      { viewport: { width, height }, colorScheme },
      async ({ page, context }) => {
        const directRequests: string[] = [];
        await context.route("https://example.com/**", async (route) => {
          directRequests.push(route.request().url());
          await route.fulfill({ contentType: "text/html", body: "<h1>Field guide</h1>" });
        });
        const gateway = await installMockGateway(page, {
          automaticallyFetchFavicons: true,
          historyMessages,
          controlUiLinkReaders: [TEST_LINK_READER],
          featureMethods: [...defaultControlUiFeatureMethods, "forge.preview", "forge.detail"],
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
                  match: { url: "https://github.com/openclaw/openclaw/pull/42" },
                  response: {
                    url: "https://github.com/openclaw/openclaw/pull/42",
                    kind: "pull",
                    owner: "openclaw",
                    repo: "openclaw",
                    number: 42,
                    title: "Custom GitHub preview",
                    state: "open",
                    login: "octocat",
                    createdAt: "2026-09-01T00:00:00Z",
                    updatedAt: "2026-09-02T00:00:00Z",
                  },
                },
              ],
            },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        const link = page.getByRole("link", { name: "Field guide", exact: true });
        await link.evaluate((element) => element.setAttribute("title", "Guide details"));
        await gateway.waitForRequest("forge.preview");
        expect(await gateway.getRequests("controlUi.linkPreview")).toEqual([]);
        await link.hover();
        const card = page.locator(".link-hovercard");
        await card.getByText(preview.title, { exact: true }).waitFor();
        await card
          .locator(".link-hovercard__image")
          .evaluate((image: HTMLImageElement) => image.decode());
        expect(await card.textContent()).toContain(preview.description);
        expect(await card.locator(".link-hovercard__identity img").count()).toBe(1);
        expect(await card.getAttribute("role")).toBe("dialog");
        expect(
          await page.evaluate(() =>
            [...document.querySelectorAll("openclaw-tooltip")].some(
              (element) => element.content === "Guide details",
            ),
          ),
        ).toBe(false);
        const bounds = await card.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
        expect(directRequests).toEqual([]);
        await page.screenshot({ path: path.join(artifacts, "after.png"), animations: "disabled" });
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
        expect(
          await page.evaluate(() =>
            [...document.querySelectorAll("openclaw-tooltip")].some(
              (element) => element.content === "Guide details",
            ),
          ),
        ).toBe(false);
        expect(await link.evaluate((element) => element === document.activeElement)).toBe(true);
        const repository = page.getByRole("link", { name: "OpenClaw repository", exact: true });
        await repository.hover();
        await card.getByText(preview.title, { exact: true }).waitFor();
        await card
          .locator(".link-hovercard__image")
          .evaluate((image: HTMLImageElement) => image.decode());
        expect(await card.locator("a").getAttribute("href")).toBe(repositoryUrl);
        expect(await card.locator(".link-hovercard__identity").textContent()).toContain(
          "github.com",
        );
        const repositoryBounds = await card.boundingBox();
        expect(repositoryBounds!.x).toBeGreaterThanOrEqual(0);
        expect(repositoryBounds!.x + repositoryBounds!.width).toBeLessThanOrEqual(width);
        expect(repositoryBounds!.y + repositoryBounds!.height).toBeLessThanOrEqual(height);
        await page.screenshot({
          path: path.join(artifacts, "repository.png"),
          animations: "disabled",
        });
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
        await notes.hover();
        await card.getByText("reference notes", { exact: true }).waitFor();
        expect(await card.locator("img").count()).toBe(0);
        await page.screenshot({
          path: path.join(artifacts, "fallback.png"),
          animations: "disabled",
        });
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
        const longBounds = await card.boundingBox();
        expect(longBounds!.x + longBounds!.width).toBeLessThanOrEqual(width);
        expect(longBounds!.y + longBounds!.height).toBeLessThanOrEqual(height);
        await page.screenshot({
          path: path.join(artifacts, "long-content.png"),
          animations: "disabled",
        });
      },
    );
  });

  it("keeps title hints when the optional hover runtime cannot load", async () => {
    await suite.withPage({}, async ({ page }) => {
      await page.route("**/link-reader-hovercard-*.js", (route) => route.abort());
      const gateway = await installMockGateway(page, {
        automaticallyFetchFavicons: true,
        historyMessages: [
          {
            role: "assistant",
            content: '[Field guide](https://example.com/field-guide "Guide details")',
            timestamp: 2000,
          },
        ],
      });
      await page.goto(suite.server.baseUrl + "chat");
      const link = page.getByRole("link", { name: "Field guide", exact: true });
      // A missing hashed chunk reloads the page; wait before hovering the new document.
      await Promise.all([
        page.waitForEvent("requestfailed", (request) =>
          request.url().includes("link-reader-hovercard-"),
        ),
        page.waitForEvent("domcontentloaded"),
        link.hover(),
      ]);
      await page.mouse.move(0, 0);
      await link.hover();
      await page.locator(".tooltip-content").filter({ hasText: "Guide details" }).waitFor();
      expect(await page.locator(".link-hovercard").count()).toBe(0);
      expect(await gateway.getRequests("controlUi.linkPreview")).toEqual([]);
    });
  });

  it("preserves detail-only, internal, session, file and explicit external-panel links", async () => {
    await suite.withPage({}, async ({ page }) => {
      const commitUrl = "https://github.com/openclaw/openclaw/commit/" + "a".repeat(40);
      const gateway = await installMockGateway(page, {
        automaticallyFetchFavicons: true,
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
      await page.goto(suite.server.baseUrl + "chat");
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
      await page.getByRole("link", { name: "Control", exact: true }).hover();
      // Network module loading is not virtual time; await it before advancing the open timer.
      await page.evaluate(() =>
        customElements.whenDefined("openclaw-link-reader-hovercard-provider"),
      );
      await page.clock.runFor(400);
      await page.locator(".link-hovercard").getByText(preview.title).waitFor();
      expect(
        (await gateway.getRequests("controlUi.linkPreview")).map((request) => request.params),
      ).toEqual([{ url: "https://example.org/control" }]);
    });
  });

  it("also previews real About-page links outside the chat renderer", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        automaticallyFetchFavicons: true,
        methodResponses: { "controlUi.linkPreview": preview },
      });
      await page.goto(suite.server.baseUrl + "settings/about");
      await page.locator('a[href="https://docs.openclaw.ai"]').hover();
      await page.locator(".link-hovercard").getByText(preview.title).waitFor();
      expect((await gateway.getRequests("controlUi.linkPreview"))[0]?.params).toEqual({
        url: "https://docs.openclaw.ai/",
      });
    });
  });

  it("makes no metadata requests with the existing automatic-fetch setting off", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        automaticallyFetchFavicons: false,
        historyMessages,
      });
      await page.goto(suite.server.baseUrl + "chat");
      const link = page.getByRole("link", { name: "Field guide", exact: true });
      await link.hover();
      await page.keyboard.press("Tab");
      await link.focus();
      expect(await page.locator(".link-hovercard").count()).toBe(0);
      expect(await gateway.getRequests("controlUi.linkPreview")).toEqual([]);
    });
  });

  it("keeps touch taps as native link navigation without fetching previews", async () => {
    await suite.withPage(
      { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
      async ({ page, context }) => {
        await context.route("https://example.com/**", (route) =>
          route.fulfill({ body: "Field guide", contentType: "text/html" }),
        );
        const gateway = await installMockGateway(page, {
          automaticallyFetchFavicons: true,
          historyMessages,
        });
        await page.goto(suite.server.baseUrl + "chat");
        const opened = context.waitForEvent("page");
        await page.getByRole("link", { name: "Field guide", exact: true }).tap();
        const destination = await opened;
        await destination.waitForURL(url);
        expect(await page.locator(".link-hovercard").count()).toBe(0);
        expect(await gateway.getRequests("controlUi.linkPreview")).toEqual([]);
        await destination.close();
      },
    );
  });
});
