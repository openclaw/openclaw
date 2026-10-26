// Control UI tests cover GitHub link hover card behavior.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { BrowserContext, Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
} from "../../../src/gateway/control-ui-contract.js";
import type { ControlUiLinkReaderPreview } from "../../../src/shared/control-ui-link-reader.js";
import { installControlUiE2eRendererStallProbe } from "../test-helpers/control-ui-e2e-renderer-stall.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { TEST_LINK_READER } from "../test-helpers/link-reader.ts";
import { waitForWatchedSessionKey } from "./chat-github-publication.test-support.ts";
import { createLightDesktopControlUiContextOptions } from "./control-ui-browser-options.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";
import {
  expectModifiedNavigation,
  pullPreviewResponse,
  PULL_HREF,
  PULL_COMMENT_HREF,
} from "./github-link-hovercard.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "GitHub link hover cards",
  trackBrowserContexts: true,
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

async function newBrowserContext(): Promise<BrowserContext> {
  return suite.newBrowserContext(createLightDesktopControlUiContextOptions());
}

async function expectText(locator: Locator, ...texts: string[]): Promise<void> {
  for (const text of texts) {
    await expect.poll(() => locator.textContent()).toContain(text);
  }
}
async function moveOff(page: Page, card: Locator) {
  await page.mouse.move(1, 1);
  await expect.poll(() => card.count()).toBe(0);
}
const part = (card: Locator, name: string) => card.locator(`.link-reader-hovercard__${name}`);
const tooltip = (page: Page) =>
  page.locator("openclaw-tooltip .tooltip-surface[popover]:popover-open");
const isFocused = (locator: Locator) =>
  locator.evaluate((element) => element === document.activeElement);
async function expectAttr(locator: Locator, name: string, value: string | null) {
  expect(await locator.getAttribute(name)).toBe(value);
}
async function expectPolledAttr(locator: Locator, name: string, value: string | null) {
  await expect.poll(() => locator.getAttribute(name)).toBe(value);
}
const assistantMessage = (text: string, timestamp?: number) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  ...(timestamp === undefined ? {} : { timestamp }),
});
function installPreview(page: Page, options: Parameters<typeof installMockGateway>[1]) {
  return installMockGateway(page, {
    controlUiLinkReaders: [TEST_LINK_READER],
    featureMethods: [...defaultControlUiFeatureMethods, "forge.preview", "forge.detail"],
    ...options,
  });
}
function referencePreview(url: string, subtitle: string, title: string) {
  return {
    match: { url },
    response: { ...pullPreviewResponse, url, subtitle, title, author: "reviewer" },
  };
}

// Shared page setup for lifecycle cases and cached permalink navigation.
async function openPullPreviewPage(
  deferPreview = false,
  previewResponse: ControlUiLinkReaderPreview = pullPreviewResponse,
  detailResponse?: ControlUiLinkReaderPreview & { body: string },
  deferHovercard = false,
): Promise<{
  card: Locator;
  commentLink: Locator;
  gateway: Awaited<ReturnType<typeof installMockGateway>>;
  page: Page;
  pullLink: Locator;
  hovercardModule: Awaited<ReturnType<typeof holdModuleResponse>> | undefined;
}> {
  const context = await newBrowserContext();
  await context.route("https://github.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Synthetic GitHub destination</title>
        <h1>Synthetic GitHub destination</h1><pre id="destination"></pre>
        <script>document.getElementById("destination").textContent = location.href;</script>`,
    }),
  );

  const page = await context.newPage();
  const hovercardModule = deferHovercard
    ? await holdModuleResponse(page, /\/link-reader-hovercard-[^/]+\.js(?:\?|$)/u)
    : undefined;
  await installControlUiE2eRendererStallProbe(page);
  await page.clock.install();
  const gateway = await installPreview(page, {
    deferredMethods: deferPreview ? ["forge.preview"] : [],
    methodResponses: {
      ...(detailResponse ? { "forge.detail": detailResponse } : {}),
      "forge.preview": {
        cases: [
          {
            match: { url: "https://github.com/openclaw/openclaw/pull/99816" },
            response: previewResponse,
          },
        ],
      },
    },
    historyMessages: [
      assistantMessage(
        `Review ${PULL_HREF}, then [the review comment](${PULL_COMMENT_HREF}).`,
        Date.now(),
      ),
    ],
  });
  await page.goto(`${suite.server.baseUrl}chat`);

  const pullLink = page.locator('a.markdown-github-link[href$="/pull/99816"]');
  const commentLink = page.getByRole("link", { name: "the review comment", exact: true });
  const card = page.locator(".link-reader-hovercard");
  await pullLink.waitFor({ state: "visible" });
  // Count transient portals as well as empty mounts; settled DOM checks miss flashes.
  await page.evaluate((pullHref) => {
    const counts = { previewMounts: 0, previewEmptyMounts: 0, titleTooltipMounts: 0 };
    for (const key of Object.keys(counts)) {
      document.body.dataset[key] = "0";
    }
    const increment = (key: keyof typeof counts) => {
      document.body.dataset[key] = String(++counts[key]);
    };
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && node.matches("openclaw-tooltip")) {
            const tip = node as HTMLElement & { anchor?: Element | null; content?: string };
            const hintedLink = tip.anchor?.closest("a");
            // The mobile sidebar can legitimately show its own unrelated hint.
            if (
              (hintedLink instanceof HTMLAnchorElement && hintedLink.href.startsWith(pullHref)) ||
              tip.content?.startsWith(pullHref)
            ) {
              increment("titleTooltipMounts");
            }
          }
          if (node instanceof Element && node.matches(".link-reader-hovercard")) {
            increment("previewMounts");
            if (!node.querySelector(".link-reader-hovercard__title")?.textContent?.trim()) {
              increment("previewEmptyMounts");
            }
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }, PULL_HREF);
  return { card, commentLink, gateway, page, pullLink, hovercardModule };
}

suite.define(() => {
  it.each([false, true])(
    "reconciles status and compact metrics (reader first: %s)",
    async (readerFirst) => {
      const { card, page, pullLink, gateway } = await openPullPreviewPage(
        readerFirst,
        {
          ...pullPreviewResponse,
          badge: { label: "Open", tone: "positive" },
        },
        {
          ...pullPreviewResponse,
          body: "The pull request is merged. This is the current source status.",
        },
      );
      if (!readerFirst) {
        await pullLink.focus();
        await expectText(card.locator(".link-reader-hovercard__state"), "Open");
        await page.keyboard.press("Escape");
      }
      await pullLink.click();
      const panel = page.locator("openclaw-link-reader-panel");
      await expectText(panel.locator(".lr-state"), "Merged");
      await page.mouse.move(1, 1);
      await page.clock.runFor(150);
      await pullLink.hover();
      await page.clock.runFor(300);
      if (readerFirst) {
        await gateway.resolveDeferred("forge.preview");
      }
      await expectText(card.locator(".link-reader-hovercard__state"), "Merged");
      await expectText(card.locator(".link-reader-hovercard__metadata"), "+101−12");
      expect((await gateway.getRequests("forge.preview")).length).toBeGreaterThan(0);
    },
  );

  it("retains reader status while the hovercard module is still loading", async () => {
    const { card, page, pullLink, hovercardModule } = await openPullPreviewPage(
      false,
      { ...pullPreviewResponse, badge: { label: "Open", tone: "positive" } },
      { ...pullPreviewResponse, body: "The pull request is merged." },
      true,
    );
    await pullLink.click();
    await expectText(page.locator("openclaw-link-reader-panel .lr-state"), "Merged");
    await hovercardModule!.request;
    expect(
      await page.evaluate(() =>
        Boolean(customElements.get("openclaw-link-reader-hovercard-provider")),
      ),
    ).toBe(false);
    hovercardModule!.release();
    await page.mouse.move(1, 1);
    await page.clock.runFor(150);
    await pullLink.hover();
    await page.clock.runFor(300);
    await expectText(card.locator(".link-reader-hovercard__state"), "Merged");
    await expectText(card.locator(".link-reader-hovercard__metadata"), "+101−12");
  });

  it("keeps all preview metadata readable with long authors on narrow screens", async () => {
    const metadata: NonNullable<ControlUiLinkReaderPreview["metadata"]> = [
      { label: "", value: "+1077", tone: "positive" },
      { label: "", value: "−189", tone: "negative" },
    ];
    const { card, page, pullLink } = await openPullPreviewPage(false, {
      ...pullPreviewResponse,
      author: "a-very-long-contributor-name-that-must-stay-readable",
      title: "fix(macos): show live status for connected saved gateways",
      metadata,
    });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.setViewportSize({ width: 320, height: 800 });
    await pullLink.focus();
    await card.waitFor({ state: "visible" });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    for (const { value } of metadata) {
      await expectText(card, value);
    }
    expect(await part(card, "metric").count()).toBe(2);
    expect(await part(card, "coauthor").count()).toBe(3);
    await expectText(part(card, "coauthors-more"), "+2");
    await expectAttr(part(card, "author"), "href", "https://github.com/steipete");
    const overflow = await card.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        card: element.scrollWidth > element.clientWidth,
        children: [...element.querySelectorAll<HTMLElement>("*")]
          .filter((child) => {
            const rect = child.getBoundingClientRect();
            return (
              rect.width > 0 &&
              (rect.left < bounds.left ||
                rect.right > bounds.right ||
                child.scrollWidth > child.clientWidth + 1)
            );
          })
          .map((child) => child.className),
      };
    });
    expect(overflow).toEqual({ card: false, children: [] });
    const colors = await card.evaluate((element) => {
      const expected = ["--ok", "--danger"].map((token) => {
        const probe = document.createElement("span");
        probe.style.color = "var(" + token + ")";
        element.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      const actual = [...element.querySelectorAll(".link-reader-hovercard__metric")]
        .slice(0, 2)
        .map((value) => getComputedStyle(value).color);
      return { actual, expected };
    });
    expect(colors.expected[0]).not.toBe(colors.expected[1]);
    expect(colors.actual).toEqual(colors.expected);
    await expectAttr(part(card, "title"), "href", PULL_HREF);
    await page.keyboard.press("Escape");
    expect(await card.count()).toBe(0);
  });

  it("keeps explicit repository references independent of the checkout and project catalog", async () => {
    const context = await newBrowserContext();
    const page = await context.newPage();
    const repository = { owner: "openclaw", repo: "openclaw" };
    const namedRepository = { owner: "openclaw", repo: "clawsweeper" };
    const gateway = await installPreview(page, {
      featureMethods: [
        ...defaultControlUiFeatureMethods,
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
        "projects.list",
        "forge.preview",
        "forge.detail",
      ],
      historyMessages: [
        assistantMessage(
          [
            "Synthetic cross-repository reproduction",
            "Original PR **openclaw/clawsweeper#1558 merged**",
            "Follow-up PR **openclaw/clawsweeper#1576 opened**",
            "Explicit checkout: PR openclaw/openclaw#1576.",
            "Unqualified: OpenClaw PR #1576 and PR #1558.",
          ].join("\n\n"),
        ),
      ],
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
        "projects.list": {
          projects: [
            ["openclaw", "OpenClaw"],
            ["clawsweeper", "ClawSweeper"],
          ].map(([id, displayName]) => ({
            id,
            displayName,
            originUrl: `https://github.com/openclaw/${id}`,
            source: "registered",
          })),
        },
        "forge.preview": {
          cases: [repository, namedRepository].flatMap((repo) =>
            [1558, 1576].map((number) =>
              referencePreview(
                `https://github.com/${repo.owner}/${repo.repo}/pull/${number}`,
                `${repo.owner}/${repo.repo} #${number}`,
                repo.repo === "clawsweeper"
                  ? "Synthetic ClawSweeper pull request"
                  : "Synthetic OpenClaw pull request",
              ),
            ),
          ),
        },
      },
    });
    await page.goto(suite.server.baseUrl + "chat");
    const key = await waitForWatchedSessionKey(gateway);
    await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
      sessions: { [key]: { repository, pullRequests: [], rateLimited: false, status: "ready" } },
    });
    const followUpRow = page.locator(".chat-bubble p").filter({ hasText: "Follow-up PR" });
    const unqualified = page.locator(".chat-bubble p").filter({ hasText: "Unqualified:" });
    await unqualified.waitFor({ state: "visible" });
    expect(await unqualified.locator("a").count()).toBe(0);
    const followUp = followUpRow.locator("a");
    await followUp.waitFor({ state: "visible" });
    await followUp.focus();
    const card = page.locator(".link-reader-hovercard");
    await card.waitFor({ state: "visible" });
    const href = "https://github.com/openclaw/clawsweeper/pull/1576";
    await expectAttr(followUp, "href", href);
    await expectAttr(part(card, "title"), "href", href);
    await expectText(card, "Synthetic ClawSweeper pull request");
    expect(
      await page.locator('a[href="https://github.com/openclaw/clawsweeper/pull/1558"]').count(),
    ).toBe(1);
    expect(
      await page.locator('a[href="https://github.com/openclaw/openclaw/pull/1576"]').count(),
    ).toBe(1);
    for (const [repo, number] of [
      [namedRepository, 1558],
      [repository, 1576],
    ] as const) {
      await page.keyboard.press("Escape");
      const target = "https://github.com/" + repo.owner + "/" + repo.repo + "/pull/" + number;
      await page.locator('a[href="' + target + '"]').focus();
      await expectPolledAttr(part(card, "title"), "href", target);
      await expectText(
        card,
        repo.repo === "clawsweeper"
          ? "Synthetic ClawSweeper pull request"
          : "Synthetic OpenClaw pull request",
      );
    }
    const requests = (await gateway.getRequests("forge.preview")).map(({ params }) => {
      if (!isRecord(params)) {
        throw new Error("Expected GitHub preview parameters");
      }
      if (typeof params.url !== "string") {
        throw new Error("Expected link-reader preview URL");
      }
      return new URL(params.url).pathname.slice(1);
    });
    expect(requests.toSorted()).toEqual([
      "openclaw/clawsweeper/pull/1558",
      "openclaw/clawsweeper/pull/1576",
      "openclaw/openclaw/pull/1576",
    ]);
  });

  it("keeps formatted PR references and their hover targets consistent", async () => {
    const context = await newBrowserContext();
    const page = await context.newPage();
    const repository = { owner: "synthetic", repo: "formatting-demo" };
    const href = "https://github.com/synthetic/formatting-demo/pull/1576";
    const otherHref = "https://github.com/synthetic/other-project/pull/1576#issuecomment-1";
    const gateway = await installPreview(page, {
      featureMethods: [
        ...defaultControlUiFeatureMethods,
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
        "forge.preview",
        "forge.detail",
      ],
      historyMessages: [
        assistantMessage(
          [
            "Synthetic formatting example",
            "Plain: PR synthetic/formatting-demo#1576 opened.",
            "Formatted: PR **synthetic/formatting-demo#1576 opened**.",
            "Short reference: **PR** synthetic/formatting-demo#42 opened.",
            `Other repository: [#1576](${otherHref})`,
          ].join("\n\n"),
        ),
      ],
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
        "forge.preview": {
          cases: [
            referencePreview(
              href,
              "synthetic/formatting-demo #1576",
              "Synthetic formatting example",
            ),
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
    const key = await waitForWatchedSessionKey(gateway);
    await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
      sessions: { [key]: { repository, pullRequests: [], rateLimited: false, status: "ready" } },
    });
    const formatted = page.locator("strong a.markdown-github-item");
    await formatted.waitFor({ state: "visible" });
    await formatted.focus();
    const card = page.locator(".link-reader-hovercard");
    await expectText(card, "Synthetic formatting example");
    await expectAttr(formatted, "href", href);
    await expectAttr(formatted, "data-github-kind", "pull");
    await expectAttr(part(card, "title"), "href", href);
    expect(await page.locator(`a[href="${href}"]`).count()).toBeGreaterThanOrEqual(2);
    expect(
      await page.locator('a[href="https://github.com/synthetic/formatting-demo/pull/42"]').count(),
    ).toBe(1);
    await page.keyboard.press("Escape");
    const other = page.locator(`a[href="${otherHref}"]`);
    await other.focus();
    await expectText(card, "Separate repository example");
    await expectAttr(part(card, "title"), "href", otherHref);
    const requests = await gateway.getRequests("forge.preview");
    expect(requests.map((request) => request.params)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: href }),
        expect.objectContaining({ url: otherHref }),
      ]),
    );
    expect(
      requests.some(
        ({ params }) =>
          isRecord(params) &&
          typeof params.url === "string" &&
          new URL(params.url).pathname.includes("/issues/"),
      ),
    ).toBe(false);
  });

  it.each([
    { theme: "light", reducedMotion: "no-preference", width: 1180, fails: false },
    { theme: "dark", reducedMotion: "reduce", width: 390, fails: true },
  ] as const)(
    "waits silently while pending, then shows the result ($theme, $reducedMotion, $width, fails=$fails)",
    async (scenario) => {
      const { card, gateway, page, pullLink } = await openPullPreviewPage(true);
      await page.emulateMedia({
        colorScheme: scenario.theme,
        reducedMotion: scenario.reducedMotion,
      });
      await page.setViewportSize({ width: scenario.width, height: 800 });
      await pullLink.focus();
      const request = await gateway.waitForRequest("forge.preview");
      expect(request.params).toMatchObject({ agentId: "main" });

      await page.clock.runFor(1_000);
      expect(await card.count()).toBe(0);
      expect(await page.locator("body").getAttribute("data-preview-mounts")).toBe("0");
      await expectAttr(pullLink, "aria-haspopup", null);
      expect(await tooltip(page).count()).toBe(0);
      expect(await page.locator("body").getAttribute("data-title-tooltip-mounts")).toBe("0");
      expect(await pullLink.getAttribute("title")).toBeFalsy();
      await expectAttr(pullLink, "href", PULL_HREF);

      if (scenario.fails) {
        const error = "GitHub API rate limit exceeded (HTTP 403). Try again in 2 minutes.";
        await gateway.rejectDeferred("forge.preview", { message: error });
        await expectText(card.getByRole("status"), error);
        await expectAttr(card, "aria-label", "Could not load preview");
        const externalLink = card.getByRole("link", { name: "Open on Forge" });
        await expectAttr(externalLink, "href", PULL_HREF);
        await expectAttr(externalLink, "target", "_blank");
        await expectAttr(pullLink, "aria-controls", await card.getAttribute("id"));
        await expectAttr(pullLink, "aria-expanded", "true");
        await expectAttr(pullLink, "aria-haspopup", "dialog");
        expect(await isFocused(pullLink)).toBe(true);
      } else {
        await gateway.resolveDeferred("forge.preview");
        await expectText(card, pullPreviewResponse.title);
      }
      expect(await page.locator("body").getAttribute("data-preview-mounts")).toBe("1");
      expect(await page.locator("body").getAttribute("data-preview-empty-mounts")).toBe("0");
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const bounds = await card.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(scenario.width);
      expect(await card.locator(".skeleton").count()).toBe(0);
      await page.keyboard.press("Tab");
      expect(await isFocused(card.locator("a").first())).toBe(true);
      await page.keyboard.press("Escape");
      await expect.poll(() => card.count()).toBe(0);
      expect(await isFocused(pullLink)).toBe(true);
    },
  );

  it("shows cached permalink failures during backoff and keeps keyboard navigation usable", async () => {
    const { card, commentLink, gateway, page, pullLink } = await openPullPreviewPage(true);
    await pullLink.focus();
    await gateway.waitForRequest("forge.preview");
    await gateway.rejectDeferred("forge.preview", {
      message: "GitHub request timed out",
    });
    await expectText(card.getByRole("status"), "GitHub request timed out");
    const externalLink = card.getByRole("link", { name: "Open on Forge" });
    await expectAttr(externalLink, "href", PULL_HREF);

    await page.keyboard.press("Tab");
    expect(await isFocused(externalLink)).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => card.count()).toBe(0);
    expect(await isFocused(pullLink)).toBe(true);

    await page.keyboard.press("Tab");
    expect(await isFocused(commentLink)).toBe(true);
    await expectText(card.getByRole("status"), "GitHub request timed out");
    await expectAttr(externalLink, "href", PULL_COMMENT_HREF);
    await commentLink.hover();
    await page.clock.runFor(300);
    await page.mouse.move(1, 1);
    await pullLink.focus();
    await pullLink.hover();
    await page.clock.runFor(300);
    await expectText(card.getByRole("status"), "GitHub request timed out");
    await expectAttr(externalLink, "href", PULL_HREF);
    expect(await page.locator("body").getAttribute("data-preview-empty-mounts")).toBe("0");
    expect(await page.locator("body").getAttribute("data-title-tooltip-mounts")).toBe("0");
    expect(await tooltip(page).count()).toBe(0);
    expect((await gateway.getRequests("forge.preview")).length).toBe(1);
    await expectAttr(pullLink, "aria-haspopup", "dialog");

    await expectModifiedNavigation(page, () => page.keyboard.press("Shift+Enter"), PULL_HREF);

    await pullLink.evaluate((element) => element.blur());
    await moveOff(page, card);
    await gateway.deferNext("forge.preview");
    await page.clock.runFor(30_000);
    await pullLink.focus();
    await expect.poll(async () => (await gateway.getRequests("forge.preview")).length).toBe(2);
    expect(await card.count()).toBe(0);
    await gateway.resolveDeferred("forge.preview");
    await expectText(card, pullPreviewResponse.title);
  });

  it("keeps a pending prefetch alive across dismissal and reuses it on rehover", async () => {
    const { card, gateway, page, pullLink } = await openPullPreviewPage(true);

    await gateway.waitForRequest("forge.preview");
    expect(await card.count()).toBe(0);
    expect(await pullLink.evaluate((element) => element.matches(":hover, :focus"))).toBe(false);
    expect(await page.locator("body").getAttribute("data-preview-mounts")).toBe("0");
    await pullLink.hover();
    await page.clock.runFor(300);
    await moveOff(page, card);

    await pullLink.hover();
    await page.clock.runFor(300);
    expect(await card.count()).toBe(0);
    // The transcript still owns this request after the popup activation ends.
    await gateway.resolveDeferred("forge.preview");
    await expectText(card, pullPreviewResponse.title);
    expect(await page.locator("body").getAttribute("data-preview-empty-mounts")).toBe("0");
    expect((await gateway.getRequests("forge.preview")).length).toBe(1);

    await moveOff(page, card);
    await pullLink.hover();
    await expectText(card, pullPreviewResponse.title);
    expect((await gateway.getRequests("forge.preview")).length).toBe(1);
  });

  it("previews issue and pull request links while preserving navigation", async () => {
    const context = await newBrowserContext();
    await context.route("https://github.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>GitHub item</title>",
      }),
    );

    const page = await context.newPage();
    await page.clock.install();
    const gateway = await installPreview(page, {
      methodResponses: {
        "forge.preview": {
          cases: [
            {
              match: { url: "https://github.com/openclaw/openclaw/pull/99816" },
              response: pullPreviewResponse,
            },
            {
              match: { url: "https://github.com/openclaw/openclaw/issues/99815" },
              response: {
                imageUrl:
                  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlY9Z8AAAAASUVORK5CYII=",
                url: "https://github.com/openclaw/openclaw/issues/99815",
                subtitle: "openclaw/openclaw #99815",
                author: "octocat",
                badge: { label: "Open", tone: "positive" },
                metadata: [{ label: "Comments", value: "4" }],
                createdAt: "2026-07-05T08:00:00Z",
                title: "Keep hover previews compact",
                updatedAt: new Date().toISOString(),
              },
            },
            {
              match: { url: "https://github.com/openclaw/openclaw/issues/999999" },
              response: {},
            },
          ],
        },
      },
      historyMessages: [
        assistantMessage(
          [
            "Review https://github.com/openclaw/openclaw/pull/99816,",
            "then https://github.com/openclaw/openclaw/issues/99815.",
            "A [missing item](https://github.com/openclaw/openclaw/issues/999999) stays usable.",
            "The [repository](https://github.com/openclaw/openclaw) has no item preview.",
            "The skill lives at https://github.com/blader/humanizer/blob/main/SKILL.md.",
            "Styling notes live in [the docs](https://docs.openclaw.ai/web/control-ui).",
          ].join(" "),
          Date.now(),
        ),
        assistantMessage(
          "Narrow reference https://github.com/a-very-long-organization-name/a-very-long-repository-name/issues/99817",
          Date.now(),
        ),
      ],
    });
    await page.goto(`${suite.server.baseUrl}chat`);

    const previewRequestsFor = async (number: number) =>
      (await gateway.getRequests("forge.preview")).filter(
        (request) =>
          isRecord(request.params) &&
          typeof request.params.url === "string" &&
          new URL(request.params.url).pathname.endsWith("/" + number),
      );

    const longHref =
      "https://github.com/a-very-long-organization-name/a-very-long-repository-name/issues/99817";
    await expectPolledAttr(
      page.getByRole("link", {
        name: "a-very-long-organization-name/a-very-long-repository-name#99817",
      }),
      "href",
      longHref,
    );
    await expectPolledAttr(
      page.getByRole("link", { name: "SKILL.md" }),
      "href",
      "https://github.com/blader/humanizer/blob/main/SKILL.md",
    );

    const pullLink = page.locator('a.markdown-github-link[href$="/pull/99816"]');

    await expectText(pullLink, "openclaw/openclaw#99816");

    const decorationLine = (link: Locator) =>
      link.evaluate((element) => getComputedStyle(element).textDecorationLine);
    expect(await decorationLine(pullLink)).toBe("none");
    expect(await decorationLine(page.getByRole("link", { name: "the docs" }))).toBe("underline");

    await pullLink.hover();
    const card = page.locator(".link-reader-hovercard");
    await expectText(card, "Merged", "openclaw/openclaw #99816", "+101", "−12");
    await page.clock.runFor(300);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await expect.poll(() => tooltip(page).count()).toBe(0);
    await expectAttr(pullLink, "title", null);
    await expect.poll(() => card.locator("img").count()).toBe(4);
    expect(await previewRequestsFor(99816)).toHaveLength(1);
    const pullBox = await card.boundingBox();
    expect(pullBox).not.toBeNull();
    expect(pullBox!.x).toBeGreaterThanOrEqual(0);
    expect(pullBox!.y).toBeGreaterThanOrEqual(0);
    expect(pullBox!.x + pullBox!.width).toBeLessThanOrEqual(1180);
    expect(pullBox!.y + pullBox!.height).toBeLessThanOrEqual(800);

    const issueLink = page.locator('a.markdown-github-link[href$="/issues/99815"]');
    await issueLink.hover();
    await expectText(card, "Keep hover previews compact", "octocat", "Comments: 4");
    await expect.poll(() => tooltip(page).count()).toBe(0);
    await expect.poll(() => card.locator("img").count()).toBe(1);
    expect(await previewRequestsFor(99815)).toHaveLength(1);

    await moveOff(page, card);

    await page.mouse.move(1, 1);
    await page.getByRole("link", { exact: true, name: "repository" }).hover();
    await page.clock.runFor(300);
    await expect.poll(() => card.count()).toBe(0);

    const fileLink = page.getByRole("link", { name: "SKILL.md" });
    await fileLink.hover();
    await expectText(
      tooltip(page).locator(".tooltip-content"),
      "https://github.com/blader/humanizer/blob/main/SKILL.md",
    );

    const missingLink = page.getByRole("link", { name: "missing item" });
    await missingLink.hover();
    await expect.poll(() => previewRequestsFor(999999)).toHaveLength(1);
    await expectText(card.getByRole("status"), "Try again or open the original.");
    await expectAttr(missingLink, "aria-haspopup", "dialog");
    await expectAttr(
      card.getByRole("link", { name: "Open on Forge" }),
      "href",
      "https://github.com/openclaw/openclaw/issues/999999",
    );
    await expectAttr(missingLink, "href", "https://github.com/openclaw/openclaw/issues/999999");
    await page.mouse.move(1, 1);

    await page.emulateMedia({ colorScheme: "dark" });
    await expectPolledAttr(page.locator("html"), "data-theme-mode", "dark");
    await pullLink.hover();
    await expectText(card, "Merged");
    expect(await previewRequestsFor(99816)).toHaveLength(1);
    await page.mouse.move(1, 1);

    await expectModifiedNavigation(page, () => pullLink.click({ modifiers: ["Shift"] }), PULL_HREF);

    const longReference = page.locator(`a[href="${longHref}"]`);
    await page.setViewportSize({ width: 320, height: 800 });
    await longReference.scrollIntoViewIfNeeded();
    const bounds = await longReference.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  });

  it("keeps the card open while the pointer crosses the gap onto it, then closes once it leaves both", async () => {
    const { card, page, pullLink } = await openPullPreviewPage();

    await pullLink.hover();
    await expectText(card, "openclaw/openclaw #99816");
    // Let preview response timers finish before freezing the pointer's grace.
    await pauseVirtualClock(page);
    const linkBox = await pullLink.boundingBox();
    expect(linkBox).not.toBeNull();
    const cardBox = await card.boundingBox();
    expect(cardBox).not.toBeNull();
    const below = (await card.getAttribute("data-side")) === "bottom";
    const linkEdgeY = below ? linkBox!.y + linkBox!.height : linkBox!.y;
    const cardEdgeY = below ? cardBox!.y : cardBox!.y + cardBox!.height;
    const gap = { x: linkBox!.x + linkBox!.width / 2, y: (linkEdgeY + cardEdgeY) / 2 };

    // Enter the card through the real gap just before the 120 ms dismissal deadline.
    await page.mouse.move(gap.x, gap.y);
    expect(
      await page.evaluate(({ x, y }) => {
        const target = document.elementFromPoint(x, y);
        return target !== null && !target.closest("a.markdown-github-link, .link-reader-hovercard");
      }, gap),
    ).toBe(true);
    await page.clock.runFor(119);
    expect(await card.count()).toBe(1);
    await page.mouse.move(cardBox!.x + cardBox!.width / 2, cardBox!.y + cardBox!.height / 2);
    expect(await card.count()).toBe(1);

    // Remaining on the card must survive ten dismissal windows.
    await page.clock.runFor(1_200);
    expect(await card.count()).toBe(1);
    await expectText(card, "openclaw/openclaw #99816");

    // Leaving both surfaces still dismisses after the traversal grace period.
    await page.mouse.move(1, 1);
    await page.clock.runFor(119);
    expect(await card.count()).toBe(1);
    await page.clock.runFor(1);
    expect(await card.count()).toBe(0);
  });

  it("exposes the card as a dialog whose title link Tab reaches and Escape leaves", async () => {
    const { card, page, pullLink } = await openPullPreviewPage();

    await pullLink.focus();
    await expectText(card, "openclaw/openclaw #99816");
    // Interactive card links require dialog, not tooltip, semantics.
    await expect.poll(() => page.getByRole("dialog").count()).toBe(1);
    await expect.poll(() => tooltip(page).count()).toBe(0);
    await expectPolledAttr(pullLink, "aria-expanded", "true");
    await expectPolledAttr(pullLink, "aria-controls", await card.getAttribute("id"));

    // Tab enters the card at its first link and then walks the rest natively.
    const focused = () => page.evaluate(() => document.activeElement?.className ?? "");
    await page.keyboard.press("Tab");
    await expect.poll(focused).toBe("link-reader-hovercard__subtitle");
    await page.keyboard.press("Tab");
    await expect.poll(focused).toBe("link-reader-hovercard__title");
    await page.keyboard.press("Tab");
    await expect.poll(focused).toBe("link-reader-hovercard__author");

    await page.keyboard.press("Escape");
    await expect.poll(() => card.count()).toBe(0);
    await expect.poll(() => isFocused(pullLink)).toBe(true);
    // Returning focus to the trigger must not reopen what Escape just dismissed.
    await page.waitForTimeout(300);
    expect(await card.count()).toBe(0);
  });

  it("opens the current pull request permalink from cached card title and repo links", async () => {
    const { card, commentLink, gateway, page, pullLink } = await openPullPreviewPage();

    await pullLink.hover();
    await expectText(card, "openclaw/openclaw #99816");
    const titleLink = part(card, "title");
    await expectText(titleLink, pullPreviewResponse.title);

    // Only the title is underlined, including on hover.
    for (const quiet of ["subtitle", "author"]) {
      const link = part(card, quiet);
      await link.hover();
      expect(await link.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("none");
    }
    await titleLink.hover();
    expect(await titleLink.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe(
      "underline",
    );

    for (const { state, anchor, href } of [
      { state: "base", anchor: pullLink, href: PULL_HREF },
      { state: "cached-comment", anchor: commentLink, href: PULL_COMMENT_HREF },
    ]) {
      const destinations = [];
      for (const clickedLink of ["title", "subtitle"]) {
        await anchor.hover();
        await expectText(card, pullPreviewResponse.title);
        const actual = {
          titleHref: await part(card, "title").getAttribute("href"),
          repoHref: await part(card, "subtitle").getAttribute("href"),
          requestCount: (await gateway.getRequests("forge.preview")).length,
        };
        const popupPromise = page.waitForEvent("popup");
        await part(card, clickedLink).click();
        const popup = await popupPromise;
        await popup.waitForLoadState("domcontentloaded");
        destinations.push({ ...actual, popupHref: popup.url() });

        // A pointer-opened card still dismisses after its clicked link gains focus.
        await popup.close();
        await moveOff(page, card);
      }
      // Retain both actual destinations before failing on a lost comment hash.
      const expected = { titleHref: href, repoHref: href, requestCount: 1, popupHref: href };
      expect(destinations, `${state} title and subtitle navigation`).toEqual([expected, expected]);
    }
    expect((await gateway.getRequests("forge.preview")).length).toBe(1);
  });
});
