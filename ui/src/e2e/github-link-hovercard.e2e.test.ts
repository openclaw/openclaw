// Control UI tests cover GitHub link hover card behavior.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { beforeEach, afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  defaultControlUiFeatureMethods,
  canRunPlaywrightChromium,
  installMockGateway,
  pauseVirtualClock,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { TEST_LINK_READER } from "../test-helpers/link-reader.ts";
import { waitForWatchedSessionKey } from "./chat-github-publication.test-support.ts";

let artifactDir: string | undefined;
beforeEach(() => {
  const parent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
  artifactDir = parent ? createControlUiE2eArtifactDir("link-reader-hovercard", parent) : undefined;
});

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let server: ControlUiE2eServer;
let browser: Browser;

async function newBrowserContext(): Promise<BrowserContext> {
  return browser.newContext({
    colorScheme: "light",
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 800, width: 1180 },
  });
}

async function closeContexts(): Promise<void> {
  const [first, ...remaining] = browser?.contexts() ?? [];
  await runQaGatewayFixture(
    async () => {
      await first?.close();
    },
    ...remaining.map((context) => () => context.close()),
  );
}

async function expectText(locator: Locator, text: string): Promise<void> {
  await expect.poll(() => locator.textContent()).toContain(text);
}

// Headless Chromium suppresses modifier-opened windows even for plain anchors.
// Observe the browser handoff after application handlers, then suppress navigation.
async function expectModifiedNavigation(page: Page, activate: () => Promise<void>, href: string) {
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

async function captureArtifact(target: Page | Locator, name: string): Promise<void> {
  if (!artifactDir) {
    return;
  }
  await target.screenshot({ path: path.join(artifactDir, `${name}.png`) });
}

const pullPreviewResponse = {
  url: "https://github.com/openclaw/openclaw/pull/99816",
  subtitle: "openclaw/openclaw #99816",
  author: "steipete",
  badge: { label: "Merged", tone: "accent" },
  metadata: [
    { label: "", value: "+101" },
    { label: "", value: "−12" },
  ],
  additions: 101,
  coAuthorCount: 5,
  coAuthors: [
    {
      login: "roboclaw-bot",
      imageUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlY9Z8AAAAASUVORK5CYII=",
    },
    {
      login: "ada",
      imageUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlY9Z8AAAAASUVORK5CYII=",
    },
    {
      login: "mira",
      imageUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlY9Z8AAAAASUVORK5CYII=",
    },
  ],
  imageUrl:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlY9Z8AAAAASUVORK5CYII=",
  changedFiles: 3,
  closedAt: "2026-07-04T09:53:52Z",
  createdAt: "2026-07-04T05:03:47Z",
  deletions: 12,
  draft: false,
  kind: "pull",
  login: "steipete",
  mergedAt: "2026-07-04T09:53:52Z",
  number: 99816,
  owner: "openclaw",
  repo: "openclaw",
  state: "closed",
  title: "fix(agents): derive conversation scope from trusted group facts",
  updatedAt: "2026-07-04T09:53:55Z",
};

const PULL_HREF = "https://github.com/openclaw/openclaw/pull/99816";
const PULL_COMMENT_HREF = `${PULL_HREF}#issuecomment-123`;

// Shared page setup for lifecycle cases and cached permalink navigation.
async function openPullPreviewPage(deferPreview = false): Promise<{
  card: Locator;
  commentLink: Locator;
  gateway: Awaited<ReturnType<typeof installMockGateway>>;
  page: Page;
  pullLink: Locator;
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
  await page.clock.install();
  const gateway = await installMockGateway(page, {
    controlUiLinkReaders: [TEST_LINK_READER],
    featureMethods: [...defaultControlUiFeatureMethods, "forge.preview", "forge.detail"],
    deferredMethods: deferPreview ? ["forge.preview"] : [],
    methodResponses: {
      "forge.preview": {
        cases: [
          {
            match: { url: "https://github.com/openclaw/openclaw/pull/99816" },
            response: pullPreviewResponse,
          },
        ],
      },
    },
    historyMessages: [
      {
        content: [
          {
            type: "text",
            text: `Review ${PULL_HREF}, then [the review comment](${PULL_COMMENT_HREF}).`,
          },
        ],
        role: "assistant",
        timestamp: Date.now(),
      },
    ],
  });
  await page.goto(`${server.baseUrl}chat`);

  const pullLink = page.locator('a.markdown-github-link[href$="/pull/99816"]');
  const commentLink = page.getByRole("link", { name: "the review comment", exact: true });
  const card = page.locator(".link-reader-hovercard");
  await pullLink.waitFor({ state: "visible" });
  // Count transient portals as well as empty mounts; settled DOM checks miss flashes.
  await page.evaluate((pullHref) => {
    document.body.dataset.previewMounts = "0";
    document.body.dataset.previewEmptyMounts = "0";
    document.body.dataset.titleTooltipMounts = "0";
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
              document.body.dataset.titleTooltipMounts = String(
                Number(document.body.dataset.titleTooltipMounts) + 1,
              );
            }
          }
          if (node instanceof Element && node.matches(".link-reader-hovercard")) {
            document.body.dataset.previewMounts = String(
              Number(document.body.dataset.previewMounts) + 1,
            );
            if (!node.querySelector(".link-reader-hovercard__title")?.textContent?.trim()) {
              document.body.dataset.previewEmptyMounts = String(
                Number(document.body.dataset.previewEmptyMounts) + 1,
              );
            }
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }, PULL_HREF);
  return { card, commentLink, gateway, page, pullLink };
}

describeControlUiE2e("GitHub link hover cards", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await runQaGatewayFixture(
      closeContexts,
      () => browser?.close(),
      () => server?.close(),
    );
  });

  afterEach(closeContexts);

  it.each([false, true])(
    "resolves named repository references through registered project context (late=%s)",
    async (late) => {
      const context = await newBrowserContext();
      const page = await context.newPage();
      const repository = { owner: "openclaw", repo: "openclaw" };
      const namedRepository = { owner: "openclaw", repo: "clawsweeper" };
      const projectName = late ? "clawsweeper" : "ClawSweeper";
      const gateway = await installMockGateway(page, {
        controlUiLinkReaders: [TEST_LINK_READER],
        featureMethods: [
          ...defaultControlUiFeatureMethods,
          SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
          "projects.list",
          "forge.preview",
          "forge.detail",
        ],
        deferredMethods: late ? ["projects.list"] : [],
        historyMessages: [
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: [
                  "Synthetic cross-repository reproduction",
                  `Original ${projectName} PR **#1558 merged**`,
                  `Follow-up ${projectName} PR **#1576 opened**`,
                  "Same checkout: OpenClaw PR #1576.",
                ].join("\n\n"),
              },
            ],
          },
        ],
        methodResponses: {
          [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
          "projects.list": {
            projects: [
              {
                id: "openclaw",
                displayName: "OpenClaw",
                originUrl: "https://github.com/openclaw/openclaw",
                source: "registered",
              },
              {
                id: "clawsweeper",
                displayName: "ClawSweeper",
                originUrl: "https://github.com/openclaw/clawsweeper",
                source: "registered",
              },
            ],
          },
          "forge.preview": {
            cases: [repository, namedRepository].flatMap((repo) =>
              [1558, 1576].map((number) => ({
                match: { url: `https://github.com/${repo.owner}/${repo.repo}/pull/${number}` },
                response: {
                  ...pullPreviewResponse,
                  url: `https://github.com/${repo.owner}/${repo.repo}/pull/${number}`,
                  subtitle: `${repo.owner}/${repo.repo} #${number}`,
                  author: "reviewer",
                  title:
                    repo.repo === "clawsweeper"
                      ? "Synthetic ClawSweeper pull request"
                      : "Synthetic OpenClaw pull request",
                  login: "reviewer",
                  coAuthors: [],
                  coAuthorCount: 0,
                },
              })),
            ),
          },
        },
      });
      await page.goto(server.baseUrl + "chat");
      const key = await waitForWatchedSessionKey(gateway);
      await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
        sessions: { [key]: { repository, pullRequests: [], rateLimited: false, status: "ready" } },
      });
      const followUpRow = page
        .locator(".chat-bubble p")
        .filter({ hasText: "Follow-up " + projectName });
      if (late) {
        await followUpRow.waitFor({ state: "visible" });
        expect(await followUpRow.locator("a").count()).toBe(0);
        await expect.poll(async () => (await gateway.getRequests("projects.list")).length).toBe(1);
        await gateway.resolveDeferred("projects.list");
      }
      const followUp = followUpRow.locator("a");
      await followUp.waitFor({ state: "visible" });
      await followUp.focus();
      const card = page.locator(".link-reader-hovercard");
      await card.waitFor({ state: "visible" });
      await captureArtifact(page, "named-repository-reference");
      const href = "https://github.com/openclaw/clawsweeper/pull/1576";
      expect(await followUp.getAttribute("href")).toBe(href);
      expect(await card.locator(".link-reader-hovercard__title").getAttribute("href")).toBe(href);
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
        await expect
          .poll(() => card.locator(".link-reader-hovercard__title").getAttribute("href"))
          .toBe(target);
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
      expect(await gateway.getRequests("projects.list")).toHaveLength(1);
      if (artifactDir) {
        await writeFile(
          path.join(artifactDir, "named-repository-requests.json"),
          JSON.stringify({ requests, late }, null, 2),
        );
      }
    },
  );

  it("keeps formatted PR references and their hover targets consistent", async () => {
    const context = await newBrowserContext();
    const page = await context.newPage();
    const repository = { owner: "synthetic", repo: "formatting-demo" };
    const href = "https://github.com/synthetic/formatting-demo/pull/1576";
    const otherHref = "https://github.com/synthetic/other-project/pull/1576#issuecomment-1";
    const gateway = await installMockGateway(page, {
      controlUiLinkReaders: [TEST_LINK_READER],
      featureMethods: [
        ...defaultControlUiFeatureMethods,
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
        "forge.preview",
        "forge.detail",
      ],
      historyMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: [
                "Synthetic formatting example",
                "Plain: PR #1576 opened.",
                "Formatted: PR **#1576 opened**.",
                "Short reference: **PR** #42 opened.",
                `Other repository: [#1576](${otherHref})`,
              ].join("\n\n"),
            },
          ],
        },
      ],
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
        "forge.preview": {
          cases: [
            {
              match: { url: href },
              response: {
                ...pullPreviewResponse,
                url: href,
                subtitle: "synthetic/formatting-demo #1576",
                title: "Synthetic formatting example",
                author: "reviewer",
              },
            },
            {
              match: { url: otherHref },
              response: {
                ...pullPreviewResponse,
                url: otherHref,
                subtitle: "synthetic/other-project #1576",
                title: "Separate repository example",
                author: "reviewer",
              },
            },
          ],
        },
      },
    });
    await page.goto(`${server.baseUrl}chat`);
    const key = await waitForWatchedSessionKey(gateway);
    await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
      sessions: { [key]: { repository, pullRequests: [], rateLimited: false, status: "ready" } },
    });
    const formatted = page.locator("strong a.markdown-github-item");
    await formatted.waitFor({ state: "visible" });
    await formatted.focus();
    const card = page.locator(".link-reader-hovercard");
    await expectText(card, "Synthetic formatting example");
    await captureArtifact(page, "formatted-pr-reference");
    expect(await formatted.getAttribute("href")).toBe(href);
    expect(await formatted.getAttribute("data-github-kind")).toBe("pull");
    expect(await card.locator(".link-reader-hovercard__title").getAttribute("href")).toBe(href);
    expect(await page.locator(`a[href="${href}"]`).count()).toBeGreaterThanOrEqual(2);
    expect(
      await page.locator('a[href="https://github.com/synthetic/formatting-demo/pull/42"]').count(),
    ).toBe(1);
    await page.keyboard.press("Escape");
    const other = page.locator(`a[href="${otherHref}"]`);
    await other.focus();
    await expectText(card, "Separate repository example");
    expect(await card.locator(".link-reader-hovercard__title").getAttribute("href")).toBe(
      otherHref,
    );
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
    { theme: "light", reducedMotion: "no-preference", width: 1180, fails: true },
    { theme: "dark", reducedMotion: "no-preference", width: 1180, fails: false },
    { theme: "dark", reducedMotion: "reduce", width: 390, fails: true },
  ] as const)(
    "waits silently for data ($theme, $reducedMotion, $width, fails=$fails)",
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
      expect(await pullLink.getAttribute("aria-haspopup")).toBeNull();
      await captureArtifact(page, "github-hovercard-pending-silent");
      expect(await page.locator("openclaw-tooltip wa-tooltip[open]").count()).toBe(0);
      expect(await page.locator("body").getAttribute("data-title-tooltip-mounts")).toBe("0");
      expect(await pullLink.getAttribute("title")).toBeFalsy();
      expect(await pullLink.getAttribute("href")).toBe(PULL_HREF);

      if (scenario.fails) {
        const error = "GitHub API rate limit exceeded (HTTP 403). Try again in 2 minutes.";
        await gateway.rejectDeferred("forge.preview", { message: error });
        await expect.poll(() => card.count()).toBe(0);
        expect(await pullLink.getAttribute("aria-controls")).toBeNull();
        expect(await pullLink.getAttribute("aria-expanded")).toBeNull();
        expect(await pullLink.getAttribute("aria-haspopup")).toBeNull();
        expect(await pullLink.evaluate((element) => element === document.activeElement)).toBe(true);
        expect(await page.locator("body").getAttribute("data-preview-mounts")).toBe("0");
        await captureArtifact(page, "github-hovercard-failure-silent");
      } else {
        await gateway.resolveDeferred("forge.preview");
        await expectText(card, pullPreviewResponse.title);
        expect(await page.locator("body").getAttribute("data-preview-mounts")).toBe("1");
        expect(await page.locator("body").getAttribute("data-preview-empty-mounts")).toBe("0");
        const bounds = await card.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(scenario.width);
        await page.keyboard.press("Tab");
        expect(
          await card
            .locator("a")
            .first()
            .evaluate((element) => element === document.activeElement),
        ).toBe(true);
        await page.keyboard.press("Escape");
        await expect.poll(() => card.count()).toBe(0);
        expect(await pullLink.evaluate((element) => element === document.activeElement)).toBe(true);
      }
      expect(await card.locator(".skeleton").count()).toBe(0);
    },
  );

  it("enables loaders across providers only after success and forgets the gate on reload", async () => {
    const { card, gateway, page, pullLink } = await openPullPreviewPage(true);
    await pullLink.focus();
    await gateway.waitForRequest("forge.preview");
    expect(await card.count()).toBe(0);
    await gateway.resolveDeferred("forge.preview");
    await expectText(card, pullPreviewResponse.title);
    await page.keyboard.press("Escape");
    await expect.poll(() => card.count()).toBe(0);

    await page.evaluate(() => {
      const source = document.querySelector(
        "openclaw-link-reader-hovercard-provider",
      ) as HTMLElement & {
        client: unknown;
        agentId?: string;
        readers: unknown;
      };
      const peer = source.cloneNode(false) as typeof source;
      peer.client = source.client;
      peer.agentId = source.agentId;
      peer.readers = source.readers;
      const anchor = document.createElement("a");
      anchor.href = "https://github.com/openclaw/openclaw/pull/99817";
      anchor.textContent = "Cross-provider preview";
      anchor.style.cssText = "position: fixed; top: 12px; right: 12px; z-index: 10000";
      peer.append(anchor);
      document.body.append(peer);
    });
    await gateway.deferNext("forge.preview");
    const peerLink = page.getByRole("link", { name: "Cross-provider preview", exact: true });
    await peerLink.hover();
    await expect.poll(() => card.getAttribute("data-loading")).toBe("true");
    expect(await card.getAttribute("aria-label")).toBe("Loading preview…");
    await gateway.rejectDeferred("forge.preview", { message: "Not Found" });
    await expect.poll(() => card.count()).toBe(0);
    const mounts = await page.locator("body").getAttribute("data-preview-mounts");
    await page.mouse.move(1, 1);
    await peerLink.hover();
    await page.clock.runFor(300);
    expect(await card.count()).toBe(0);
    expect(await page.locator("body").getAttribute("data-preview-mounts")).toBe(mounts);
    expect((await gateway.getRequests("forge.preview")).length).toBe(2);

    await page.reload();
    await pullLink.waitFor({ state: "visible" });
    await pullLink.focus();
    await gateway.waitForRequest("forge.preview");
    await page.clock.runFor(300);
    expect(await card.count()).toBe(0);
  });

  it("keeps failed permalinks silent during backoff and leaves keyboard navigation usable", async () => {
    const { card, commentLink, gateway, page, pullLink } = await openPullPreviewPage(true);
    await pullLink.focus();
    await gateway.waitForRequest("forge.preview");
    await gateway.rejectDeferred("forge.preview", {
      message: "GitHub request timed out",
    });
    await expect.poll(() => card.count()).toBe(0);

    await page.keyboard.press("Tab");
    expect(await commentLink.evaluate((element) => element === document.activeElement)).toBe(true);
    await commentLink.hover();
    await page.clock.runFor(300);
    await page.mouse.move(1, 1);
    await pullLink.focus();
    await pullLink.hover();
    await page.clock.runFor(300);
    expect(await card.count()).toBe(0);
    expect(await page.locator("body").getAttribute("data-preview-mounts")).toBe("0");
    expect(await page.locator("body").getAttribute("data-title-tooltip-mounts")).toBe("0");
    expect(await page.locator("openclaw-tooltip wa-tooltip[open]").count()).toBe(0);
    expect((await gateway.getRequests("forge.preview")).length).toBe(1);
    expect(await pullLink.getAttribute("aria-haspopup")).toBeNull();

    await expectModifiedNavigation(page, () => page.keyboard.press("Shift+Enter"), PULL_HREF);
  });

  it.each(["pointer", "focus"])(
    "does not show a late successful response after %s leaves",
    async (trigger) => {
      const { card, gateway, page, pullLink } = await openPullPreviewPage(true);
      if (trigger === "pointer") {
        await pullLink.hover();
      } else {
        await pullLink.focus();
      }
      await gateway.waitForRequest("forge.preview");
      if (trigger === "pointer") {
        await page.mouse.move(1, 1);
      } else {
        await pullLink.evaluate((element) => element.blur());
      }
      await gateway.resolveDeferred("forge.preview");
      await page.clock.runFor(300);
      expect(await card.count()).toBe(0);
      expect(await page.locator("body").getAttribute("data-preview-mounts")).toBe("0");
      expect(await pullLink.getAttribute("aria-controls")).toBeNull();
    },
  );

  it("warms visible links before first hover and shares data across permalinks", async () => {
    const { card, commentLink, gateway, page, pullLink } = await openPullPreviewPage(true);

    await gateway.waitForRequest("forge.preview");
    expect(await card.count()).toBe(0);
    expect(await pullLink.evaluate((element) => element.matches(":hover, :focus"))).toBe(false);
    await gateway.resolveDeferred("forge.preview");
    await pullLink.hover();
    await expectText(card, pullPreviewResponse.title);
    await page.mouse.move(1, 1);
    await expect.poll(() => card.count()).toBe(0);
    await commentLink.focus();
    await expectText(card, pullPreviewResponse.title);
    expect(await card.locator(".link-reader-hovercard__title").getAttribute("href")).toBe(
      PULL_COMMENT_HREF,
    );
    expect(await gateway.getRequests("forge.preview")).toHaveLength(1);
  });

  it("keeps a pending prefetch alive across dismissal and reuses it on rehover", async () => {
    const proofDir =
      artifactDir ?? createControlUiE2eArtifactDir("link-reader-hovercard-cancellation");
    const { card, gateway, page, pullLink } = await openPullPreviewPage(true);

    await gateway.waitForRequest("forge.preview");
    expect(await card.count()).toBe(0);
    expect(await page.locator("body").getAttribute("data-preview-mounts")).toBe("0");
    await pullLink.hover();
    await page.clock.runFor(300);
    await page.mouse.move(1, 1);
    await expect.poll(() => card.count()).toBe(0);

    await pullLink.hover();
    await page.clock.runFor(300);
    expect(await card.count()).toBe(0);
    // The transcript still owns this request after the popup activation ends.
    await gateway.resolveDeferred("forge.preview");
    await expectText(card, pullPreviewResponse.title);
    expect(await page.locator("body").getAttribute("data-preview-empty-mounts")).toBe("0");
    // Capture the settled state even when the title assertion below fails.
    await page.screenshot({
      path: path.join(proofDir, "github-hovercard-cancellation-rehover.png"),
    });
    await expectText(card, pullPreviewResponse.title);
    expect((await gateway.getRequests("forge.preview")).length).toBe(1);

    await page.mouse.move(1, 1);
    await expect.poll(() => card.count()).toBe(0);
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
    const gateway = await installMockGateway(page, {
      controlUiLinkReaders: [TEST_LINK_READER],
      featureMethods: [...defaultControlUiFeatureMethods, "forge.preview", "forge.detail"],
      methodResponses: {
        "forge.preview": {
          cases: [
            {
              match: { url: "https://github.com/openclaw/openclaw/pull/99816" },
              response: {
                ...pullPreviewResponse,
                additions: 101,
                imageUrl:
                  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlY9Z8AAAAASUVORK5CYII=",
                changedFiles: 3,
                closedAt: "2026-07-04T09:53:52Z",
                createdAt: "2026-07-04T05:03:47Z",
                deletions: 12,
                draft: false,
                kind: "pull",
                login: "steipete",
                mergedAt: "2026-07-04T09:53:52Z",
                number: 99816,
                owner: "openclaw",
                repo: "openclaw",
                state: "closed",
                title: "fix(agents): derive conversation scope from trusted group facts",
                updatedAt: "2026-07-04T09:53:55Z",
              },
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
                comments: 4,
                createdAt: "2026-07-05T08:00:00Z",
                kind: "issue",
                login: "octocat",
                number: 99815,
                owner: "openclaw",
                repo: "openclaw",
                state: "open",
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
        {
          content: [
            {
              type: "text",
              text: [
                "Review https://github.com/openclaw/openclaw/pull/99816,",
                "then https://github.com/openclaw/openclaw/issues/99815.",
                "A [missing item](https://github.com/openclaw/openclaw/issues/999999) stays usable.",
                "The [repository](https://github.com/openclaw/openclaw) has no item preview.",
                "The skill lives at https://github.com/blader/humanizer/blob/main/SKILL.md.",
                "Styling notes live in [the docs](https://docs.openclaw.ai/web/control-ui).",
              ].join(" "),
            },
          ],
          role: "assistant",
          timestamp: Date.now(),
        },
        {
          content: [
            {
              type: "text",
              text: "Narrow reference https://github.com/a-very-long-organization-name/a-very-long-repository-name/issues/99817",
            },
          ],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });
    await page.goto(`${server.baseUrl}chat`);

    const previewRequestsFor = async (number: number) =>
      (await gateway.getRequests("forge.preview")).filter(
        (request) =>
          isRecord(request.params) &&
          typeof request.params.url === "string" &&
          new URL(request.params.url).pathname.endsWith("/" + number),
      );
    const message = page.locator(".chat-text").filter({ hasText: "Review" });
    if (artifactDir) {
      await message.screenshot({ path: path.join(artifactDir, "github-references-light.png") });
      await page.emulateMedia({ colorScheme: "dark" });
      await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("dark");
      await message.screenshot({ path: path.join(artifactDir, "github-references-dark.png") });
      await page.emulateMedia({ colorScheme: "light" });
      await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("light");
    }

    await expect
      .poll(() => page.getByRole("link", { name: "#99817" }).getAttribute("href"))
      .toBe(
        "https://github.com/a-very-long-organization-name/a-very-long-repository-name/issues/99817",
      );
    await expect
      .poll(() => page.getByRole("link", { name: "SKILL.md" }).getAttribute("href"))
      .toBe("https://github.com/blader/humanizer/blob/main/SKILL.md");

    const pullLink = page.locator('a.markdown-github-link[href$="/pull/99816"]');

    const decorationLine = (link: Locator) =>
      link.evaluate((element) => getComputedStyle(element).textDecorationLine);
    expect(await decorationLine(pullLink)).toBe("none");
    expect(await decorationLine(page.getByRole("link", { name: "the docs" }))).toBe("underline");

    await pullLink.hover();
    const card = page.locator(".link-reader-hovercard");
    await expectText(card, "Merged");
    await expectText(card, "openclaw/openclaw #99816");
    await expectText(card, "+101");
    await expectText(card, "−12");
    expect(await card.getByText("3 files", { exact: true }).count()).toBe(0);
    expect(await card.locator(".link-reader-hovercard__metric--files").count()).toBe(0);
    await page.clock.runFor(300);
    await captureArtifact(page, "github-hovercard-title-tooltip");
    await expect.poll(() => page.locator("openclaw-tooltip[open]").count()).toBe(0);
    expect(await pullLink.getAttribute("title")).toBeNull();
    await expect.poll(() => card.locator("img").count()).toBe(1);
    expect(await previewRequestsFor(99816)).toHaveLength(1);
    const pullBox = await card.boundingBox();
    expect(pullBox).not.toBeNull();
    expect(pullBox!.x).toBeGreaterThanOrEqual(0);
    expect(pullBox!.y).toBeGreaterThanOrEqual(0);
    expect(pullBox!.x + pullBox!.width).toBeLessThanOrEqual(1180);
    expect(pullBox!.y + pullBox!.height).toBeLessThanOrEqual(800);

    const issueLink = page.locator('a.markdown-github-link[href$="/issues/99815"]');
    await issueLink.hover();
    await expectText(card, "Keep hover previews compact");
    await expectText(card, "octocat");
    await expectText(card, "Comments: 4");
    await expect.poll(() => page.locator("openclaw-tooltip[open]").count()).toBe(0);
    await expect.poll(() => card.locator("img").count()).toBe(1);
    expect(await previewRequestsFor(99815)).toHaveLength(1);

    await page.mouse.move(1, 1);
    await expect.poll(() => card.count()).toBe(0);
    await issueLink.hover();
    await expectText(card, "Comments: 4");
    expect(await previewRequestsFor(99815)).toHaveLength(1);

    await page.mouse.move(1, 1);
    await page.getByRole("link", { exact: true, name: "repository" }).hover();
    await page.clock.runFor(300);
    await expect.poll(() => card.count()).toBe(0);

    const fileLink = page.getByRole("link", { name: "SKILL.md" });
    await fileLink.hover();
    await expect
      .poll(() => page.locator("openclaw-tooltip[open]").textContent())
      .toContain("https://github.com/blader/humanizer/blob/main/SKILL.md");

    const missingLink = page.getByRole("link", { name: "missing item" });
    await missingLink.hover();
    await expect.poll(() => previewRequestsFor(999999)).toHaveLength(1);
    await expect.poll(() => card.count()).toBe(0);
    expect(await missingLink.getAttribute("aria-haspopup")).toBeNull();
    expect(await missingLink.getAttribute("href")).toBe(
      "https://github.com/openclaw/openclaw/issues/999999",
    );
    await page.mouse.move(1, 1);

    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("dark");
    await pullLink.hover();
    await expectText(card, "Merged");
    expect(await previewRequestsFor(99816)).toHaveLength(1);
    await page.mouse.move(1, 1);

    await pullLink.focus();
    await expectText(card, "Merged");
    await expect.poll(() => page.locator("openclaw-tooltip[open]").count()).toBe(0);
    await page.keyboard.press("Escape");
    await expect.poll(() => card.count()).toBe(0);
    await expect
      .poll(() => pullLink.evaluate((element) => element === document.activeElement))
      .toBe(true);

    await expectModifiedNavigation(page, () => pullLink.click({ modifiers: ["Shift"] }), PULL_HREF);
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

    // Cross the actual top/bottom gap using native pointer events, then enter
    // the card just before the existing 120 ms dismissal deadline.
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
    await captureArtifact(page, "github-hovercard-pointer-open");

    // Staying on the card holds it open regardless of elapsed time, mirroring
    // the unit test's ten-grace-window persistence check.
    await page.clock.runFor(1_200);
    expect(await card.count()).toBe(1);
    await expectText(card, "openclaw/openclaw #99816");

    // Leaving both surfaces, with no click, still dismisses the card after the
    // traversal grace period.
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
    // The real accessibility tree has to report a dialog, not a tooltip: the card
    // owns a link, which tooltip semantics may not contain.
    await expect.poll(() => page.getByRole("dialog").count()).toBe(1);
    await expect.poll(() => pullLink.getAttribute("aria-expanded")).toBe("true");
    await expect
      .poll(() => pullLink.getAttribute("aria-controls"))
      .toBe(await card.getAttribute("id"));

    // Tab enters the card at its first link and then walks the rest natively.
    const focused = () => page.evaluate(() => document.activeElement?.className ?? "");
    await page.keyboard.press("Tab");
    await expect.poll(focused).toBe("link-reader-hovercard__subtitle");
    await page.keyboard.press("Tab");
    await expect.poll(focused).toBe("link-reader-hovercard__title");
    await captureArtifact(page, "github-hovercard-keyboard-focus");

    await page.keyboard.press("Escape");
    await expect.poll(() => card.count()).toBe(0);
    await expect
      .poll(() => pullLink.evaluate((element) => element === document.activeElement))
      .toBe(true);
    // Returning focus to the trigger must not reopen what Escape just dismissed.
    await page.waitForTimeout(300);
    expect(await card.count()).toBe(0);
  });

  it("opens the current pull request permalink from cached card title and repo links", async () => {
    const proofDir =
      artifactDir ?? createControlUiE2eArtifactDir("link-reader-hovercard-navigation");
    const { card, commentLink, gateway, page, pullLink } = await openPullPreviewPage();

    await pullLink.hover();
    await expectText(card, "openclaw/openclaw #99816");
    const titleLink = card.locator(".link-reader-hovercard__title");
    await expectText(titleLink, pullPreviewResponse.title);

    // The title owns the card's only underline; the other links stay quiet even
    // under the pointer, so the card keeps reading as a preview and not a menu.
    for (const quiet of ["subtitle", "author"]) {
      const link = card.locator(`.link-reader-hovercard__${quiet}`);
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
      const observations = [];
      for (const clickedLink of ["title", "subtitle"]) {
        await anchor.hover();
        await expectText(card, pullPreviewResponse.title);
        const actual = {
          titleHref: await card.locator(".link-reader-hovercard__title").getAttribute("href"),
          repoHref: await card.locator(".link-reader-hovercard__subtitle").getAttribute("href"),
          requestCount: (await gateway.getRequests("forge.preview")).length,
        };
        const stage = `${state}-${clickedLink}`;
        await page.screenshot({ path: path.join(proofDir, `${stage}-card.png`) });
        const popupPromise = page.waitForEvent("popup");
        await card.locator(`.link-reader-hovercard__${clickedLink}`).click();
        const popup = await popupPromise;
        await popup.waitForLoadState("domcontentloaded");
        const observation = {
          state,
          clickedLink,
          actual: { ...actual, popupHref: popup.url() },
          expected: {
            titleHref: href,
            repoHref: href,
            requestCount: 1,
            popupHref: href,
          },
        };
        await popup.screenshot({ path: path.join(proofDir, `${stage}-popup.png`) });
        await writeFile(path.join(proofDir, `${stage}.json`), JSON.stringify(observation, null, 2));
        observations.push(observation);

        // A pointer-opened card still dismisses after its clicked link gains focus.
        await popup.close();
        await page.mouse.move(1, 1);
        await expect.poll(() => card.count()).toBe(0);
      }
      // Retain both actual destinations before failing on a lost comment hash.
      for (const { actual, expected, clickedLink } of observations) {
        expect(actual.popupHref, `${state} ${clickedLink} navigation`).toBe(expected.popupHref);
        expect(actual).toEqual(expected);
      }
    }
    expect((await gateway.getRequests("forge.preview")).length).toBe(1);
  });
});
