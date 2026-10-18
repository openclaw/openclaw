import type { BrowserContext, Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "../../../src/gateway/control-ui-csp.js";
import type {
  ControlUiLinkReaderDocument,
  ControlUiLinkReaderDescriptor,
} from "../../../src/shared/control-ui-link-reader.js";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const imageUrl = "https://user-images.githubusercontent.com/1/github-sidebar-proof.png";
const fallbackImageUrl = "https://images.example/existing-reader-image.png";
const sha = "abcdef1234567890abcdef1234567890abcdef12";
const repoUrl = "https://github.com/openclaw/openclaw";
const timestamp = "2026-09-13T11:00:00Z";
const issueUrl = `${repoUrl}/issues/42`;
const pullUrl = `${repoUrl}/pull/43`;
const commitUrl = `${repoUrl}/commit/${sha}`;
const comment = (id: string, documentUrl: string, body: string) => ({
  id,
  url: `${documentUrl}#${id}`,
  body,
  author: "reviewer",
  createdAt: timestamp,
});
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
  url: issueUrl,
  title: "Read GitHub without leaving the conversation",
  subtitle: "openclaw/openclaw · #42",
  author: "octocat",
  badge: { label: "Open", tone: "positive" },
  createdAt: "2026-09-13T10:00:00Z",
  updatedAt: timestamp,
  body: `Keep the conversation visible while reviewing **issues, pull requests, and commits**.\n\n- Read the discussion\n- Inspect the patch\n- Return to chat\n\n[Related pull request](../pull/43)\n\n![Architecture screenshot](${imageUrl})\n\n![Existing remote image](${fallbackImageUrl})`,
  comments: [
    comment(
      "issuecomment-123",
      issueUrl,
      `<!-- hidden-review-metadata -->\n\nThe sidebar keeps the review beside the conversation.\n\n<img src="${imageUrl}" alt="Comment screenshot" width="320" />`,
    ),
  ],
  commentsTotal: 1,
} satisfies ControlUiLinkReaderDocument;
const file = {
  path: "ui/src/components/link-reader-panel.tsx",
  status: "modified",
  additions: 3,
  deletions: 1,
  patch:
    '@@ -1,2 +1,4 @@\n-export const destination = "external";\n+export const destination = "sidebar";\n+// Keep the chat in view.\n+export const readOnly = true;',
};
const pull = {
  ...issue,
  url: pullUrl,
  title: "feat(ui): open GitHub links in a side panel",
  subtitle: "openclaw/openclaw · #43",
  body: "A native reader with **browser-style navigation**, discussion, and file diffs.",
  badge: { label: "Merged", tone: "accent" },
  comments: [
    {
      ...comment("discussion_r124", pullUrl, "Keep the image beside this reviewed line."),
      label: "Review comment",
      context: { path: file.path, lineLabel: "2", label: "After change", diff: file.patch },
    },
  ],
  files: [file],
  filesTotal: 1,
} satisfies ControlUiLinkReaderDocument;
const commit = {
  url: commitUrl,
  title: "Render GitHub documents beside chat",
  subtitle: "openclaw/openclaw · " + sha.slice(0, 12),
  author: "octocat",
  createdAt: timestamp,
  badge: { label: "Commit", tone: "neutral" },
  body: "Render GitHub documents beside chat\n\nPreserve native modified-click behavior.",
  comments: [comment("commitcomment-125", commitUrl, "Commit discussion is available here too.")],
  commentsTotal: 1,
  files: [file],
} satisfies ControlUiLinkReaderDocument;

const suite = createControlUiE2eSuite({ name: "GitHub side panel" });
const named = (scope: Page | Locator, role: Parameters<Page["getByRole"]>[0], name: string) =>
  scope.getByRole(role, { name, exact: true });
const heading = (panel: Locator, name: string) => named(panel, "heading", name).waitFor();
const clickButton = (panel: Locator, name: string) => named(panel, "button", name).click();
const waitText = (panel: Locator, text: string) => panel.getByText(text, { exact: true }).waitFor();
const tabCount = (header: Locator, count: number) =>
  expect.poll(() => header.getByRole("tab").count()).toBe(count);
function installReader(
  page: Page,
  text: string,
  options: Parameters<typeof installMockGateway>[1],
) {
  return installMockGateway(page, {
    controlUiLinkReaders: readers,
    models: [{ id: "reader-demo", name: "Demo", provider: "demo" }],
    agentModel: "demo/reader-demo",
    sessionInfo: { model: "reader-demo", modelProvider: "demo" },
    sessions: [{ key: "agent:main:main", model: "reader-demo", modelProvider: "demo" }],
    historyMessages: [
      { role: "assistant", timestamp: Date.now(), content: [{ type: "text", text }] },
    ],
    ...options,
  });
}
async function imageCookie(context: BrowserContext, domain: string) {
  await context.addCookies([
    {
      name: "reader_test_cookie",
      value: "present",
      domain,
      path: "/",
      secure: true,
      sameSite: "None",
    },
  ]);
}

suite.define(() => {
  it("reads issues, pull requests, and commits beside chat with history, refresh, and external escape", async () => {
    await suite.withPage(
      {
        viewport: { width: 1500, height: 940 },
        colorScheme: "light",
        locale: "en-US",
        serviceWorkers: "block",
      },
      async ({ context, page }) => {
        await imageCookie(context, "user-images.githubusercontent.com");
        await context.route("https://github.com/**", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: "<!doctype html><title>GitHub external destination</title>",
          }),
        );
        // Apply the Gateway owner's real HTTP policy to the shipped browser bundle.
        await page.route(suite.server.baseUrl + "**", async (route) => {
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
        const mediaRequests: Array<Record<string, string>> = [],
          fallbackRequests: Array<Record<string, string>> = [];
        for (const [url, requests, headers] of [
          [imageUrl, mediaRequests, {}],
          [fallbackImageUrl, fallbackRequests, { "Access-Control-Allow-Origin": "*" }],
        ] as const) {
          await context.route(url, (route) => {
            requests.push(route.request().headers());
            return route.fulfill({
              contentType: "image/png",
              headers,
              body: Buffer.from(png, "base64"),
            });
          });
        }
        await imageCookie(context, "images.example");
        const gateway = await installReader(
          page,
          `Review the [issue](${issue.url}), the [pull request](${pull.url}), and the [commit](${commit.url}) without losing this conversation.`,
          {
            featureMethods: [
              "chat.startup",
              "chat.metadata",
              "github.detail",
              "github.preview",
              "github.image",
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
          },
        );
        await page.goto(`${suite.server.baseUrl}chat`);
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
        await issueLink.click();
        const panel = page.locator("openclaw-link-reader-panel");
        const panelHeader = page.locator('[data-region-header="side"]');
        const active = panel.locator(".lr-content:not([hidden])");
        await heading(panel, issue.title);
        await waitText(panel, "The sidebar keeps the review beside the conversation.");
        // The shared session region owns layout; measure chat, not its container that also holds the reader.
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
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
        expect({
          cookie: fallbackRequests[0]?.cookie,
          referer: fallbackRequests[0]?.referer,
        }).toEqual({ cookie: undefined, referer: undefined });
        expect(await gateway.getRequests("github.image")).toHaveLength(2);
        expect(await active.textContent()).not.toContain("hidden-review-metadata");
        expect(await page.locator("body").getAttribute("data-reader-image-csp-blocked")).toBeNull();
        await tabCount(panelHeader, 1);
        await named(active, "link", "Related pull request").click();
        await heading(panel, pull.title);
        expect(await panelHeader.getByRole("tab").count()).toBe(1);
        expect(context.pages()).toHaveLength(1);
        await clickButton(panel, "Back");
        await heading(panel, issue.title);

        await named(chat, "link", "pull request").click();
        await heading(panel, pull.title);
        await waitText(panel, "Merged");
        await active.locator(".lr-files .lr-file summary").click();
        await active.locator(".lr-files .lr-diff").waitFor();
        expect(await active.locator(".lr-files .lr-diff").textContent()).toContain("sidebar");
        await waitText(active, "Keep the image beside this reviewed line.");
        await tabCount(panelHeader, 2);

        await named(chat, "link", "commit").click();
        await heading(panel, commit.title);
        await waitText(active, "Commit discussion is available here too.");
        await tabCount(panelHeader, 3);
        await named(panelHeader, "tab", pull.title).click();
        await heading(panel, pull.title);
        expect(
          await active
            .locator(".lr-files .lr-file")
            .evaluate((element) => (element as HTMLDetailsElement).open),
        ).toBe(true);
        await named(panelHeader, "tab", commit.title).click();
        await heading(panel, commit.title);
        await expect.poll(() => panelHeader.locator(".tabstrip-tab__icon svg").count()).toBe(3);
        await clickButton(panel, "Refresh item");
        await expect
          .poll(async () =>
            (await gateway.getRequests("github.detail")).some(
              (request) => (request.params as { refresh?: boolean }).refresh === true,
            ),
          )
          .toBe(true);
        await heading(panel, commit.title);
        await page.emulateMedia({ colorScheme: "dark" });
        await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("dark");
        await active.locator(".lr-files .lr-file summary").click();

        const external = page.waitForEvent("popup");
        await named(panel, "link", "Open on GitHub").click();
        const popup = await external;
        await popup.waitForLoadState("domcontentloaded");
        expect(popup.url()).toBe(commit.url);
        await popup.close();
        const address = panel.locator(".lr-url");
        await address.fill(issue.url);
        await address.press("Enter");
        await heading(panel, issue.title);
        await clickButton(panel, "Back");
        await heading(panel, commit.title);
        await panelHeader.locator(".tabstrip-tab__close").last().click();
        await tabCount(panelHeader, 2);
        await selectChatLayoutAction(page, "Minimize side panel");
        await expect.poll(() => panel.locator(".link-reader-panel").isVisible()).toBe(false);
        expect(
          await page.evaluate(() =>
            document.documentElement.style.getPropertyValue("--oc-link-reader-reserve-right"),
          ),
        ).toBe(""); // Embedded readers leave global dock reservations untouched.

        await page.setViewportSize({ width: 390, height: 844 });
        await issueLink.click();
        await heading(panel, issue.title);
        const mobileBox = await panel.locator(".link-reader-panel").boundingBox();
        expect(mobileBox!.x).toBeGreaterThanOrEqual(0);
        expect(mobileBox!.x + mobileBox!.width).toBeLessThanOrEqual(391);
        expect(mobileBox!.width).toBeGreaterThanOrEqual(300);
        await selectChatLayoutAction(page, "Minimize side panel");
        await expect.poll(() => panel.locator(".link-reader-panel").isVisible()).toBe(false);
      },
    );
  });
  it("does not fetch rejected image sources while parsing or mounting remote Markdown", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ context, page }) => {
      const requested: string[] = [];
      await context.route("**/github-untrusted-image*", (route) => {
        requested.push(route.request().url());
        return route.fulfill({ contentType: "image/png", body: "" });
      });
      const sources = [
        new URL("/github-untrusted-image-same-origin.png", suite.server.baseUrl).href,
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
              `<img src="${src}" alt="Blocked image" srcset="https://images.example/github-untrusted-image-srcset.png 2x" onerror="window.githubImageScriptRan=true">`,
          )
          .join("\n\n"),
      };
      await installReader(page, `[Image security fixture](${issue.url})`, {
        featureMethods: ["chat.startup", "chat.metadata", "github.detail"],
        methodResponses: { "github.detail": hostile },
      });
      await page.goto(suite.server.baseUrl + "chat");
      await page.getByRole("link", { name: "Image security fixture", exact: true }).click();
      const panel = page.locator("openclaw-link-reader-panel");
      await heading(panel, issue.title);
      await expect.poll(() => panel.locator(".lr-image-caption").count()).toBe(sources.length);
      expect(await panel.locator(".lr-markdown img").count()).toBe(0);
      // A paint flush also lets any parser-initiated image requests surface.
      await page.screenshot({ animations: "disabled" });
      expect(requested).toEqual([]);
      expect(
        await page.evaluate(() => Reflect.get(window, "githubImageScriptRan")),
      ).toBeUndefined();
    });
  });
});
