import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "../../../src/gateway/control-ui-csp.js";
import type {
  ControlUiLinkReaderDocument,
  ControlUiLinkReaderDescriptor,
} from "../../../src/shared/control-ui-link-reader.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const imageUrl = "https://user-images.githubusercontent.com/1/github-sidebar-proof.png";
const fallbackImageUrl = "https://images.example/existing-reader-image.png";
const sha = "abcdef1234567890abcdef1234567890abcdef12";
const readers: ControlUiLinkReaderDescriptor[] = [
  {
    pluginId: "github",
    id: "references",
    label: "GitHub",
    icon: "github",
    linkReader: {
      hosts: ["github.com"],
      pathPattern: "^/[^/]+/[^/]+/(issues/[0-9]+|pull/[0-9]+(?:/files)?|commit/[a-f0-9]{7,40})$",
      detailMethod: "github.detail",
      previewMethod: "github.preview",
      imageMethod: "github.image",
    },
  },
];
const issue = {
  url: "https://github.com/openclaw/openclaw/issues/42",
  title: "Read GitHub without leaving the conversation",
  subtitle: "openclaw/openclaw · #42",
  author: "octocat",
  badge: { label: "Open", tone: "positive" },
  createdAt: "2026-09-13T10:00:00Z",
  updatedAt: "2026-09-13T11:00:00Z",
  body:
    "Keep the conversation visible while reviewing **issues, pull requests, and commits**.\n\n- Read the discussion\n- Inspect the patch\n- Return to chat\n\n[Related pull request](../pull/43)\n\n![Architecture screenshot](" +
    imageUrl +
    ")\n\n![Existing remote image](" +
    fallbackImageUrl +
    ")",
  comments: [
    {
      id: "issuecomment-123",
      url: "https://github.com/openclaw/openclaw/issues/42#issuecomment-123",
      author: "reviewer",
      createdAt: "2026-09-13T11:00:00Z",
      body:
        '<!-- hidden-review-metadata -->\n\nThe sidebar keeps the review beside the conversation.\n\n<img src="' +
        imageUrl +
        '" alt="Comment screenshot" width="320" />',
    },
  ],
  commentsTotal: 1,
} satisfies ControlUiLinkReaderDocument;
const file = {
  path: "ui/src/components/link-reader-panel.ts",
  status: "modified",
  additions: 3,
  deletions: 1,
  patch:
    '@@ -1,2 +1,4 @@\n-export const destination = "external";\n+export const destination = "sidebar";\n+// Keep the chat in view.\n+export const readOnly = true;',
};
const pull = {
  ...issue,
  url: "https://github.com/openclaw/openclaw/pull/43",
  title: "feat(ui): open GitHub links in a side panel",
  subtitle: "openclaw/openclaw · #43",
  body: "A native reader with **browser-style navigation**, discussion, and file diffs.",
  badge: { label: "Merged", tone: "accent" },
  comments: [
    {
      id: "discussion_r124",
      url: "https://github.com/openclaw/openclaw/pull/43#discussion_r124",
      author: "reviewer",
      createdAt: "2026-09-13T11:00:00Z",
      label: "Review comment",
      body: "Keep the image beside this reviewed line.",
      context: { path: file.path, lineLabel: "2", label: "After change", diff: file.patch },
    },
  ],
  files: [file],
  filesTotal: 1,
} satisfies ControlUiLinkReaderDocument;
const commit = {
  url: "https://github.com/openclaw/openclaw/commit/" + sha,
  title: "Render GitHub documents beside chat",
  subtitle: "openclaw/openclaw · " + sha.slice(0, 12),
  author: "octocat",
  createdAt: "2026-09-13T11:00:00Z",
  badge: { label: "Commit", tone: "neutral" },
  body: "Render GitHub documents beside chat\n\nPreserve native modified-click behavior.",
  comments: [
    {
      id: "commitcomment-125",
      url: "https://github.com/openclaw/openclaw/commit/" + sha + "#commitcomment-125",
      author: "reviewer",
      createdAt: "2026-09-13T11:00:00Z",
      body: "Commit discussion is available here too.",
    },
  ],
  commentsTotal: 1,
  files: [file],
} satisfies ControlUiLinkReaderDocument;

let browser: Browser;
let server: ControlUiE2eServer;
const artifactParent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
async function capture(page: Page, name: string, artifacts: string) {
  await page.screenshot({ animations: "disabled", path: path.join(artifacts, `${name}.png`) });
}

describe("GitHub side panel", () => {
  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    });
    server = await startControlUiE2eServer();
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("reads issues, pull requests, and commits beside chat with history, refresh, and external escape", async () => {
    const artifacts = createControlUiE2eArtifactDir("github-reader", artifactParent);
    const context = await browser.newContext({
      viewport: { width: 1500, height: 940 },
      colorScheme: "light",
      locale: "en-US",
      serviceWorkers: "block",
      ...(artifactParent
        ? { recordVideo: { dir: artifacts, size: { width: 1500, height: 940 } } }
        : {}),
    });
    try {
      await context.addCookies([
        {
          name: "reader_test_cookie",
          value: "present",
          domain: "user-images.githubusercontent.com",
          path: "/",
          secure: true,
          sameSite: "None",
        },
      ]);
      await context.route("https://github.com/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>GitHub external destination</title>",
        }),
      );
      const page = await context.newPage();
      // Apply the Gateway owner's real HTTP policy to the shipped browser bundle.
      await page.route(server.baseUrl + "**", async (route) => {
        if (route.request().resourceType() !== "document") {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        const html = await response.text();
        await route.fulfill({
          response,
          headers: {
            ...response.headers(),
            "content-security-policy": buildControlUiCspHeader({
              inlineScriptHashes: computeInlineScriptHashes(html),
            }),
          },
        });
      });
      const png = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = 120;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#163c52";
        ctx.fillRect(0, 0, 320, 120);
        ctx.fillStyle = "#64d7d2";
        ctx.fillRect(20, 25, 90, 70);
        ctx.fillStyle = "#ffffff";
        ctx.font = "18px sans-serif";
        ctx.fillText("Inline screenshot", 125, 65);
        return canvas.toDataURL("image/png").split(",")[1]!;
      });
      const mediaRequests: Array<Record<string, string>> = [];
      await context.route(imageUrl, (route) => {
        mediaRequests.push(route.request().headers());
        return route.fulfill({
          contentType: "image/png",
          body: Buffer.from(png, "base64"),
        });
      });
      const fallbackRequests: Array<Record<string, string>> = [];
      await context.addCookies([
        {
          name: "reader_test_cookie",
          value: "present",
          domain: "images.example",
          path: "/",
          secure: true,
          sameSite: "None",
        },
      ]);
      await context.route(fallbackImageUrl, (route) => {
        fallbackRequests.push(route.request().headers());
        return route.fulfill({
          contentType: "image/png",
          headers: { "Access-Control-Allow-Origin": "*" },
          body: Buffer.from(png, "base64"),
        });
      });
      const gateway = await installMockGateway(page, {
        controlUiLinkReaders: readers,
        models: [{ id: "reader-demo", name: "Demo", provider: "demo" }],
        agentModel: "demo/reader-demo",
        sessionInfo: { model: "reader-demo", modelProvider: "demo" },
        sessions: [{ key: "agent:main:main", model: "reader-demo", modelProvider: "demo" }],
        featureMethods: [
          "chat.startup",
          "chat.metadata",
          "github.detail",
          "github.preview",
          "github.image",
        ],
        historyMessages: [
          {
            role: "assistant",
            timestamp: Date.now(),
            content: [
              {
                type: "text",
                text: `Review the [issue](${issue.url}), the [pull request](${pull.url}), and the [commit](${commit.url}) without losing this conversation.`,
              },
            ],
          },
        ],
        methodResponses: {
          "github.image": {
            cases: [
              {
                match: { url: imageUrl },
                response: { url: imageUrl, dataUrl: `data:image/png;base64,${png}` },
              },
              {
                match: { url: fallbackImageUrl },
                response: { url: fallbackImageUrl, dataUrl: "" },
              },
            ],
          },
          "github.detail": {
            cases: [
              { match: { url: issue.url }, response: issue },
              { match: { url: pull.url }, response: pull },
              { match: { url: commit.url }, response: commit },
            ],
          },
        },
      });
      await page.goto(`${server.baseUrl}chat`);
      const chat = page
        .locator(".chat-text")
        .filter({ hasText: "without losing this conversation" });
      const issueLink = chat.getByRole("link", { name: "issue", exact: true });
      await issueLink.waitFor();
      await page.evaluate(() => {
        document.addEventListener("securitypolicyviolation", (event) => {
          if (event.effectiveDirective === "img-src") {
            document.body.setAttribute("data-reader-image-csp-blocked", event.blockedURI);
          }
        });
      });
      await capture(page, "github-before", artifacts);
      await issueLink.click();
      const panel = page.locator("openclaw-link-reader-panel");
      const panelHeader = page.locator('[data-region-header="side"]');
      const active = panel.locator(".lr-content:not([hidden])");
      await panel.getByRole("heading", { name: issue.title, exact: true }).waitFor();
      await panel
        .getByText("The sidebar keeps the review beside the conversation.", { exact: true })
        .waitFor();
      // The shared session region owns layout; measure chat, not its container that also holds the reader.
      await expect
        .poll(async () => {
          const contentBox = await page
            .locator('.sidebar-region__primary[data-region="main"]')
            .boundingBox();
          const panelBox = await panel.locator(".link-reader-panel").boundingBox();
          return contentBox && panelBox ? contentBox.x + contentBox.width - panelBox.x : Infinity;
        })
        .toBeLessThanOrEqual(1);
      expect(context.pages()).toHaveLength(1);
      await expect
        .poll(() =>
          active
            .locator("img")
            .evaluateAll(
              (images) =>
                images.filter(
                  (image) =>
                    (image as HTMLImageElement).complete &&
                    (image as HTMLImageElement).naturalWidth === 320,
                ).length,
            ),
        )
        .toBe(3);
      expect(mediaRequests).toEqual([]);
      expect(fallbackRequests).toHaveLength(1);
      expect(fallbackRequests[0]?.cookie).toBeUndefined();
      expect(fallbackRequests[0]?.referer).toBeUndefined();
      expect(await gateway.getRequests("github.image")).toHaveLength(2);
      expect(await active.textContent()).not.toContain("hidden-review-metadata");
      expect(await page.locator("body").getAttribute("data-reader-image-csp-blocked")).toBeNull();
      await expect.poll(() => panelHeader.getByRole("tab").count()).toBe(1);
      await capture(page, "github-issue-light", artifacts);
      await active.getByRole("link", { name: "Related pull request", exact: true }).click();
      await panel.getByRole("heading", { name: pull.title, exact: true }).waitFor();
      expect(await panelHeader.getByRole("tab").count()).toBe(1);
      expect(context.pages()).toHaveLength(1);
      await panel.getByRole("button", { name: "Back", exact: true }).click();
      await panel.getByRole("heading", { name: issue.title, exact: true }).waitFor();

      await chat.getByRole("link", { name: "pull request", exact: true }).click();
      await panel.getByRole("heading", { name: pull.title, exact: true }).waitFor();
      await panel.getByText("Merged", { exact: true }).waitFor();
      await active.locator(".lr-files .lr-file summary").click();
      await active.locator(".lr-files .lr-diff").waitFor();
      expect(await active.locator(".lr-files .lr-diff").textContent()).toContain("sidebar");
      await active
        .getByText("Keep the image beside this reviewed line.", { exact: true })
        .waitFor();
      await expect.poll(() => panelHeader.getByRole("tab").count()).toBe(2);
      await capture(page, "github-pr-diff-light", artifacts);

      await chat.getByRole("link", { name: "commit", exact: true }).click();
      await panel.getByRole("heading", { name: commit.title, exact: true }).waitFor();
      await active.getByText("Commit discussion is available here too.", { exact: true }).waitFor();
      await expect.poll(() => panelHeader.getByRole("tab").count()).toBe(3);
      await panelHeader.getByRole("tab", { name: pull.title, exact: true }).click();
      await panel.getByRole("heading", { name: pull.title, exact: true }).waitFor();
      expect(
        await active
          .locator(".lr-files .lr-file")
          .evaluate((element) => (element as HTMLDetailsElement).open),
      ).toBe(true);
      await panelHeader.getByRole("tab", { name: commit.title, exact: true }).click();
      await panel.getByRole("heading", { name: commit.title, exact: true }).waitFor();
      await expect.poll(() => panelHeader.locator(".tabstrip-tab__icon svg").count()).toBe(3);
      await panel.getByRole("button", { name: "Refresh item", exact: true }).click();
      await expect
        .poll(async () =>
          (await gateway.getRequests("github.detail")).some(
            (request) => (request.params as { refresh?: boolean }).refresh === true,
          ),
        )
        .toBe(true);
      await panel.getByRole("heading", { name: commit.title, exact: true }).waitFor();
      await page.emulateMedia({ colorScheme: "dark" });
      await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("dark");
      await active.locator(".lr-files .lr-file summary").click();
      await capture(page, "github-commit-dark", artifacts);

      const external = page.waitForEvent("popup");
      await panel.getByRole("link", { name: "Open on GitHub", exact: true }).click();
      const popup = await external;
      await popup.waitForLoadState("domcontentloaded");
      expect(popup.url()).toBe(commit.url);
      await popup.close();
      const address = panel.locator(".lr-url");
      await address.fill(issue.url);
      await address.press("Enter");
      await panel.getByRole("heading", { name: issue.title, exact: true }).waitFor();
      await panel.getByRole("button", { name: "Back", exact: true }).click();
      await panel.getByRole("heading", { name: commit.title, exact: true }).waitFor();
      await panelHeader.locator(".tabstrip-tab__close").last().click();
      await expect.poll(() => panelHeader.getByRole("tab").count()).toBe(2);
      await panelHeader.locator(".side-panel__minimize").click();
      await expect.poll(() => panel.locator(".link-reader-panel").isVisible()).toBe(false);
      expect(
        await page.evaluate(() =>
          document.documentElement.style.getPropertyValue("--oc-link-reader-reserve-right"),
        ),
      ).toBe(""); // Embedded readers leave global dock reservations untouched.

      await page.setViewportSize({ width: 390, height: 844 });
      await issueLink.click();
      await panel.getByRole("heading", { name: issue.title, exact: true }).waitFor();
      const mobileBox = await panel.locator(".link-reader-panel").boundingBox();
      expect(mobileBox!.x).toBeGreaterThanOrEqual(0);
      expect(mobileBox!.x + mobileBox!.width).toBeLessThanOrEqual(391);
      expect(mobileBox!.width).toBeGreaterThanOrEqual(300);
      await capture(page, "github-issue-mobile", artifacts);
      await panelHeader.locator(".side-panel__minimize").click();
      await expect.poll(() => panel.locator(".link-reader-panel").isVisible()).toBe(false);
    } finally {
      await context.close();
    }
  });
  it("does not fetch rejected image sources while parsing or mounting remote Markdown", async () => {
    const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      const requested: string[] = [];
      await context.route("**/github-untrusted-image*", (route) => {
        requested.push(route.request().url());
        return route.fulfill({ contentType: "image/png", body: "" });
      });
      const page = await context.newPage();
      const sources = [
        new URL("/github-untrusted-image-same-origin.png", server.baseUrl).href,
        "https://127.0.0.1/github-untrusted-image-ip.png",
        "https://localhost/github-untrusted-image-local.png",
        "https://host.local/github-untrusted-image-lan.png",
        "http://images.example/github-untrusted-image-http.png",
      ];
      const hostile = {
        ...issue,
        comments: [],
        commentsTotal: 0,
        body: sources
          .map(
            (src) =>
              '<img src="' +
              src +
              '" alt="Blocked image" srcset="https://images.example/github-untrusted-image-srcset.png 2x" onerror="window.githubImageScriptRan=true">',
          )
          .join("\n\n"),
      };
      await installMockGateway(page, {
        controlUiLinkReaders: readers,
        models: [{ id: "reader-demo", name: "Demo", provider: "demo" }],
        agentModel: "demo/reader-demo",
        sessionInfo: { model: "reader-demo", modelProvider: "demo" },
        sessions: [{ key: "agent:main:main", model: "reader-demo", modelProvider: "demo" }],
        featureMethods: ["chat.startup", "chat.metadata", "github.detail"],
        historyMessages: [
          {
            role: "assistant",
            timestamp: Date.now(),
            content: [{ type: "text", text: "[Image security fixture](" + issue.url + ")" }],
          },
        ],
        methodResponses: { "github.detail": hostile },
      });
      await page.goto(server.baseUrl + "chat");
      await page.getByRole("link", { name: "Image security fixture", exact: true }).click();
      const panel = page.locator("openclaw-link-reader-panel");
      await panel.getByRole("heading", { name: issue.title, exact: true }).waitFor();
      await expect.poll(() => panel.locator(".lr-image-caption").count()).toBe(sources.length);
      expect(await panel.locator(".lr-markdown img").count()).toBe(0);
      // A paint flush also lets any parser-initiated image requests surface.
      await page.screenshot({ animations: "disabled" });
      expect(requested).toEqual([]);
      expect(
        await page.evaluate(() => Reflect.get(window, "githubImageScriptRan")),
      ).toBeUndefined();
    } finally {
      await context.close();
    }
  });
});
