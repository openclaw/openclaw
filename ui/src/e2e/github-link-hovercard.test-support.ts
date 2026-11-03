import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { BrowserContext, Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
} from "../../../src/gateway/control-ui-contract.js";
import type {
  ControlUiLinkReaderDescriptor,
  ControlUiLinkReaderPreview,
} from "../../../src/shared/control-ui-link-reader.js";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { GITHUB_REPOSITORY_PLUGIN as GITHUB_REFERENCE_PLUGIN } from "../test-helpers/repository-plugin.ts";
import { waitForWatchedSessionKey } from "./chat-github-publication.test-support.ts";
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

export const GITHUB_REFERENCE_READER: ControlUiLinkReaderDescriptor = {
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
export { GITHUB_REPOSITORY_PLUGIN as GITHUB_REFERENCE_PLUGIN } from "../test-helpers/repository-plugin.ts";

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
    methodResponses: { "projects.list": { projects: [] }, ...options.methodResponses },
    nativePlugins: options.nativePlugins ?? [GITHUB_REFERENCE_PLUGIN],
    controlUiLinkReaders: [GITHUB_REFERENCE_READER],
    featureMethods: [
      ...(options.featureMethods ?? defaultControlUiFeatureMethods),
      "projects.list",
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
  it.each([false, true])(
    "resolves named repository references through registered project context (late=%s)",
    async (late) => {
      const context = await newBrowserContext();
      const page = await context.newPage();
      const repository = { owner: "openclaw", repo: "openclaw" };
      const namedRepository = { owner: "openclaw", repo: "clawsweeper" };
      const projectName = late ? "clawsweeper" : "ClawSweeper";
      const gateway = await installReferencePreview(page, {
        featureMethods: [
          ...defaultControlUiFeatureMethods,
          SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
          "projects.list",
          "github.preview",
          "github.detail",
        ],
        deferredMethods: late ? ["projects.list"] : [],
        historyMessages: [
          assistantMessage(
            [
              "Synthetic cross-repository reproduction",
              `Original ${projectName} PR **#1558 merged**`,
              `Follow-up ${projectName} PR **#1576 opened**`,
              "Same checkout: OpenClaw PR #1576.",
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
          "github.preview": {
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
      const requests = (await gateway.getRequests("github.preview")).map(({ params }) => {
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
    },
  );

  it.each([true, false])(
    "keeps formatted PR references and their hover targets consistent (repository contribution=%s)",
    async (enabled) => {
      const context = await newBrowserContext();
      const page = await context.newPage();
      const repository = { owner: "synthetic", repo: "formatting-demo" };
      const href = "https://github.com/synthetic/formatting-demo/pull/1576";
      const otherHref = "https://github.com/synthetic/other-project/pull/1576#issuecomment-1";
      const gateway = await installReferencePreview(page, {
        nativePlugins: enabled ? [GITHUB_REFERENCE_PLUGIN] : [],
        featureMethods: [
          ...defaultControlUiFeatureMethods,
          SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
          "github.preview",
          "github.detail",
        ],
        historyMessages: [
          assistantMessage(
            [
              "Synthetic Gateway formatting example",
              "Plain: PR #1576 opened.",
              "Formatted: PR **#1576 opened**.",
              "Short reference: **PR** #42 opened.",
              `Other repository: [#1576](${otherHref})`,
            ].join("\n\n"),
          ),
        ],
        methodResponses: {
          [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
          "github.preview": {
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
      await page.getByText("Synthetic Gateway formatting example", { exact: true }).waitFor();
      if (enabled) {
        const key = await waitForWatchedSessionKey(gateway);
        await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
          sessions: {
            [key]: { repository, pullRequests: [], rateLimited: false, status: "ready" },
          },
        });
      }
      const formatted = page.locator("strong a.markdown-github-item");
      try {
        if (enabled) {
          await formatted.waitFor({ state: "visible" });
        } else {
          expect(await formatted.count()).toBe(0);
          expect(await gateway.getRequests("projects.list")).toHaveLength(0);
        }
      } finally {
        await page
          .locator(".chat-bubble")
          .filter({ hasText: "Synthetic Gateway formatting example" })
          .screenshot({
            path: path.join(suite.artifactDir, `github-reference-contribution-${enabled}.png`),
          });
      }
      if (!enabled) {
        await page.locator(`a[href="${otherHref}"]`).focus();
        await expectText(page.locator(".link-reader-hovercard"), "Separate repository example");
        return;
      }
      await formatted.focus();
      const card = page.locator(".link-reader-hovercard");
      await expectText(card, "Synthetic formatting example");
      await expectAttr(formatted, "href", href);
      await expectAttr(formatted, "data-github-kind", "pull");
      await expectAttr(part(card, "title"), "href", href);
      expect(await page.locator(`a[href="${href}"]`).count()).toBeGreaterThanOrEqual(2);
      expect(
        await page
          .locator('a[href="https://github.com/synthetic/formatting-demo/pull/42"]')
          .count(),
      ).toBe(1);
      await page.keyboard.press("Escape");
      const other = page.locator(`a[href="${otherHref}"]`);
      await other.focus();
      await expectText(card, "Separate repository example");
      await expectAttr(part(card, "title"), "href", otherHref);
      const requests = await gateway.getRequests("github.preview");
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
    },
  );
}
