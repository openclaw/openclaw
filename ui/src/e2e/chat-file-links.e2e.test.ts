import fs from "node:fs";
import nodePath from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { selectFileAction } from "./chat-file-actions.test-support.ts";
import { chatMessage } from "./chat-flow.test-support.ts";
import {
  exactButton,
  polledAttribute,
  polledCount,
  polledText,
} from "./chat-presentation.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:main";
const suite = createControlUiE2eSuite({
  name: "Control UI chat file links",
  startServerBeforeBrowser: true,
});
const withPage = (run: (page: Page) => Promise<void>) =>
  suite.withPage({ viewport: { height: 900, width: 1280 } }, ({ page }) => run(page));

const previewResponse = <T extends object>(name: string, fields: T) => ({
  root: "/workspace",
  sessionKey,
  file: fileInfo(name, fields),
});
const fileRequest = (path: string) => ({ agentId: "main", path, sessionKey });

function fileInfo<T extends object>(name: string, fields: T) {
  return { kind: "read", missing: false, name, path: name, workspacePath: name, ...fields };
}

suite.define(() => {
  it("preserves domain/path text in user messages", async () => {
    await withPage(async (page) => {
      const text = "Please check the portal.example/service.test reference.";
      const gateway = await installMockGateway(page, {
        historyMessages: [{ role: "user", content: [{ type: "text", text }], timestamp: 1 }],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const bubble = page.locator(".chat-bubble").filter({ hasText: "Please check" });
      await bubble.waitFor({ state: "visible" });
      expect(await bubble.textContent()).toContain(text);
      expect(await bubble.locator("a[data-file-path]").count()).toBe(0);
      expect(await gateway.getRequests("sessions.files.get")).toHaveLength(0);
    });
  });

  it.each(["file", "close", "list"] as const)(
    "shows a file tab before completion and honors the %s intent",
    async (intent) => {
      await withPage(async (page) => {
        const file = {
          root: "/workspace",
          sessionKey,
          file: fileInfo("slow.ts", {
            previewKind: "text",
            contentEncoding: "utf8",
            content: "export const loaded = true;\n",
            path: "src/slow.ts",
            workspacePath: "src/slow.ts",
          }),
        };
        const gateway = await installMockGateway(page, {
          deferredMethods: [
            "sessions.files.get",
            ...(intent === "list" ? ["sessions.files.list"] : []),
          ],
          historyMessages: [chatMessage("assistant", "Review `src/slow.ts`.", { timestamp: 1 })],
          methodResponses: {
            "sessions.files.get": file,
            "sessions.files.list": {
              sessionKey: file.sessionKey,
              root: file.root,
              files: [],
              browser: { path: "", entries: [] },
            },
          },
        });
        const response = await page.goto(`${suite.server.baseUrl}chat`);
        expect(response?.status()).toBe(200);
        if (intent === "list") {
          await openChatSidePanelType(page, "Files");
          await gateway.waitForRequest("sessions.files.list");
        }

        await page.locator('a.markdown-file-link[data-file-path="src/slow.ts"]').click();
        await gateway.waitForRequest("sessions.files.get");

        await page.locator('[data-region-header="side"]').waitFor({ state: "visible" });
        const fileTab = page
          .locator(".side-panel__header .tabstrip-tab")
          .filter({ hasText: "slow.ts" });
        await polledCount(fileTab).toBe(1);
        expect(await page.locator(".sidebar-file-view").count()).toBe(0);
        if (intent === "close") {
          await exactButton(page, "Close tab: slow.ts").click();
          await fileTab.waitFor({ state: "detached" });
        } else if (intent === "list") {
          await gateway.resolveDeferred("sessions.files.list");
          await gateway.waitForRequest("artifacts.list");
        }

        await gateway.resolveDeferred("sessions.files.get");
        await page.evaluate(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        );
        const fileView = page.locator(".sidebar-file-view:visible");
        if (intent !== "close") {
          await fileView.waitFor({ state: "visible" });
          await polledText(fileView.locator(".cm-content")).toContain(
            "export const loaded = true;",
          );
        }
        if (intent === "close") {
          expect(await fileTab.count()).toBe(0);
          expect(await page.locator(".sidebar-file-view").count()).toBe(0);
        } else {
          expect(await fileView.count()).toBe(1);
          expect(await fileView.locator(".cm-content").textContent()).toContain(
            "export const loaded = true;",
          );
        }
      });
    },
  );

  it("keeps authored and root-distinct file targets through click and keyboard", async () => {
    const files = [
      {
        requestPath: "/workspace/src/file.ts",
        workspacePath: "src/file.ts",
        name: "file.ts",
        marker: "export const absoluteTarget = true;",
      },
      {
        requestPath: "workspace/src/file.ts",
        workspacePath: "workspace/src/file.ts",
        name: "file.ts",
        marker: "export const relativeTarget = true;",
      },
      ...["café note.md", "emoji-🌱.md", "100% ready.txt", "日本語.txt"].map((name, index) => ({
        requestPath: `qa241-unicode/${name}`,
        workspacePath: `qa241-unicode/${name}`,
        name,
        marker: `WORKSPACE_CONTENT_${index}`,
      })),
    ];
    await withPage(async (page) => {
      const gateway = await installMockGateway(page, {
        workspace: "/workspace",
        historyMessages: [
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: [
                  "Compare /workspace/src/file.ts:7 and `workspace/src/file.ts:7`.",
                  ...files
                    .slice(2)
                    .map((file) => `[${file.name}](${encodeURI(file.requestPath)}:7)`),
                  "See docs/README.md.",
                ].join("\n"),
              },
            ],
            timestamp: 1,
          },
        ],
        methodResponses: {
          "sessions.files.get": {
            cases: files.map((file) => ({
              match: { path: file.requestPath },
              response: {
                root: "/workspace",
                sessionKey,
                file: fileInfo(file.name, {
                  content: `// 1\n// 2\n// 3\n// 4\n// 5\n// 6\n${file.marker}\n`,
                  contentEncoding: "utf8",
                  path: file.workspacePath,
                  previewKind: "text",
                  workspacePath: file.workspacePath,
                }),
              },
            })),
          },
        },
      });
      const response = await page.goto(`${suite.server.baseUrl}chat`);
      const links = page.locator(".chat-thread a.markdown-file-link");
      await links.nth(files.length).waitFor({ state: "visible" });
      const chatUrl = page.url();
      const labels = await links.evaluateAll((anchors) =>
        anchors.map((anchor) => ({
          path: anchor.getAttribute("data-file-path"),
          line: anchor.getAttribute("data-file-line"),
          text: anchor.textContent,
        })),
      );
      for (const [index, file] of files.entries()) {
        const before = (await gateway.getRequests("sessions.files.get")).length;
        const target = page.locator(`.chat-thread a[data-file-path="${file.requestPath}"]`);
        if (index % 2 === 0) {
          await target.click();
        } else {
          await target.focus();
          await page.keyboard.press(index === 3 ? "Space" : "Enter");
        }
        await gateway.waitForRequest("sessions.files.get", { after: before });
        const fileView = page.locator(".sidebar-file-view");
        await fileView.waitFor({ state: "visible" });
        await polledText(fileView.locator(".cm-content")).toContain(file.marker);
        await polledAttribute(fileView.locator(".file-view__line--target"), "data-line").toBe("7");
        expect(page.url()).toBe(chatUrl);
        await exactButton(page, `Close tab: ${file.name}`).click();
        await fileView.waitFor({ state: "detached" });
      }
      const requests = await gateway.getRequests("sessions.files.get");
      expect(response?.status()).toBe(200);
      expect(labels.map(({ path: targetPath, line }) => ({ path: targetPath, line }))).toEqual([
        { path: "/workspace/src/file.ts", line: "7" },
        { path: "workspace/src/file.ts", line: "7" },
        { path: "qa241-unicode/café note.md", line: "7" },
        { path: "qa241-unicode/emoji-🌱.md", line: "7" },
        { path: "qa241-unicode/100% ready.txt", line: "7" },
        { path: "qa241-unicode/日本語.txt", line: "7" },
        { path: "docs/README.md", line: null },
      ]);
      expect(requests.map((request) => request.params)).toEqual([
        fileRequest("/workspace/src/file.ts"),
        fileRequest("workspace/src/file.ts"),
        ...files.slice(2).map((file) => ({
          agentId: "main",
          path: file.requestPath,
          sessionKey,
        })),
      ]);
      expect(labels.map((label) => label.text)).toEqual([
        "/workspace/src/file.ts:7",
        "workspace/src/file.ts:7",
        "café note.md",
        "emoji-🌱.md",
        "100% ready.txt",
        "日本語.txt",
        "README.md",
      ]);
    });
  });

  it("reveals and saves the selected file without losing Files search or focus", async () => {
    await withPage(async (page) => {
      const initialText = "# Project\n\nNested workspace notes.\n";
      const initialSize = Buffer.byteLength(initialText, "utf8");
      const savedText = "# Project\n\nSaved workspace notes — café 雪 🦞.\n";
      const savedSize = Buffer.byteLength(savedText, "utf8");
      const listing = {
        root: "/workspace",
        sessionKey,
        gitCheckout: true,
        files: [
          {
            kind: "modified",
            name: "README.md",
            path: "README.md",
            workspacePath: "packages/app/README.md",
            size: initialSize,
          },
        ],
        browser: {
          entries: [
            { kind: "file", name: "README.md", path: "packages/app/README.md", size: initialSize },
          ],
          path: "",
        },
      };
      const fileResponse = (content: string, hash: string) => ({
        cases: ["README.md", "/workspace/packages/app/README.md"].map((requestPath) => ({
          match: { path: requestPath },
          response: {
            root: "/workspace",
            sessionKey,
            file: fileInfo("README.md", {
              previewKind: "text",
              contentEncoding: "utf8",
              content,
              hash,
              kind: "modified",
              workspacePath: "packages/app/README.md",
              path: requestPath.replace(/^\/workspace\//, ""),
            }),
          },
        })),
      });
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "sessions.files.set", "sessions.diff"],
        historyMessages: [
          chatMessage(
            "assistant",
            "Review `README.md:2` or `/workspace/packages/app/README.md:3`.",
            { timestamp: 1 },
          ),
        ],
        methodResponses: {
          "sessions.files.get": fileResponse(initialText, "before-hash"),
          "sessions.files.list": listing,
          "sessions.files.set": {
            sessionKey,
            file: { hash: "after-hash", size: savedSize },
          },
          "sessions.diff": {
            sessionKey,
            root: "/workspace",
            gitCheckout: true,
            files: [],
            additions: 0,
            deletions: 0,
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await openChatSidePanelType(page, "Review");
      await gateway.waitForRequest("sessions.diff");
      await openChatSidePanelType(page, "Files");
      const workspace = page.getByRole("complementary", { name: "Session workspace", exact: true });
      await workspace.getByRole("button", { name: "Filter files: All", exact: true }).click();
      await workspace.getByRole("menuitemradio", { name: "Changed", exact: true }).click();
      const chatLink = page.locator('a.markdown-file-link[data-file-path="README.md"]');
      await chatLink.waitFor({ state: "visible" });
      await chatLink.click();

      const fileView = page.locator(".sidebar-file-view");
      await fileView.waitFor({ state: "visible" });
      const originalEditor = await fileView.locator(".cm-editor").elementHandle();
      expect(await fileView.locator(".file-view__line--target").getAttribute("data-line")).toBe(
        "2",
      );
      expect((await gateway.getRequests("sessions.files.get"))[0]?.params).toMatchObject({
        path: "README.md",
      });

      const beforeReveal = (await gateway.getRequests("sessions.files.list")).length;
      await selectFileAction(fileView, "Show in Files");
      await gateway.waitForRequest("sessions.files.list", { after: beforeReveal });
      expect(
        (await gateway.getRequests("sessions.files.list"))[beforeReveal]?.params,
      ).toMatchObject({
        path: "packages/app",
      });
      await workspace.getByRole("button", { name: "Filter files: All", exact: true }).waitFor();
      const browserRow = workspace.getByRole("button", { name: "README.md", exact: true });
      await browserRow.click();
      await fileView.waitFor({ state: "visible" });
      await gateway.waitForRequest("sessions.files.get", { after: 1 });
      expect((await gateway.getRequests("sessions.files.get"))[1]?.params).toMatchObject({
        path: "README.md",
      });
      // The unified catalog keeps session origin; an authored absolute link exercises alias deduplication.
      await page
        .locator('a.markdown-file-link[data-file-path="/workspace/packages/app/README.md"]')
        .click();
      await polledAttribute(fileView.locator(".file-view__line--target"), "data-line").toBe("3");
      await page.getByRole("button", { name: "Toggle file tree", exact: true }).click();
      await polledAttribute(browserRow, "aria-current").toBe("true");
      expect(
        await page
          .locator(".side-panel__header .tabstrip-tab")
          .filter({ hasText: "README.md" })
          .count(),
      ).toBe(1);
      const reads = await gateway.getRequests("sessions.files.get");
      expect(reads).toHaveLength(3);
      expect(reads[2]?.params).toMatchObject({ path: "/workspace/packages/app/README.md" });
      expect(await originalEditor!.evaluate((element) => element.isConnected)).toBe(true);
      expect(await fileView.locator(".file-view__line--target").getAttribute("data-line")).toBe(
        "3",
      );
      await selectFileAction(fileView, "Show in Files");
      await workspace.getByRole("button", { name: "Search files", exact: true }).click();
      const search = workspace.getByRole("searchbox", { name: "Search files", exact: true });
      await search.fill("README");
      await expect
        .poll(async () => (await gateway.getRequests("sessions.files.list")).at(-1)?.params)
        .toMatchObject({ search: "README" });
      await browserRow.click();
      await selectFileAction(fileView, "Edit file");
      await fileView.locator(".cm-content").fill(savedText);
      await gateway.setMethodResponse("sessions.files.list", {
        ...listing,
        files: listing.files.map((file) => Object.assign({}, file, { size: savedSize })),
        browser: {
          ...listing.browser,
          search: "README",
          entries: listing.browser.entries.map((file) =>
            Object.assign({}, file, { size: savedSize }),
          ),
        },
      });
      await exactButton(fileView, "Save").click();
      await expect.poll(() => exactButton(fileView, "Save").isDisabled()).toBe(true);
      expect((await gateway.getRequests("sessions.files.set")).at(-1)?.params).toMatchObject({
        content: savedText,
        expectedHash: "before-hash",
      });
      expect(await fileView.isVisible()).toBe(true);
      await exactButton(page, "Close tab: README.md").click();
      await openChatSidePanelType(page, "Files");
      await search.waitFor({ state: "visible" });
      expect(await search.inputValue()).toBe("README");
      await gateway.setMethodResponse("sessions.files.get", fileResponse(savedText, "after-hash"));
      const beforeReopen = (await gateway.getRequests("sessions.files.get")).length;
      await browserRow.click();
      await fileView.waitFor({ state: "visible" });
      await selectFileAction(fileView, "Edit file");
      await polledText(fileView.locator(".cm-content")).toContain(
        "Saved workspace notes — café 雪 🦞.",
      );
      expect(await gateway.getRequests("sessions.files.get")).toHaveLength(beforeReopen + 1);
    });
  });

  it("previews text and browser-safe images while falling back for unsupported binaries", async () => {
    const png = fs.readFileSync(nodePath.resolve(process.cwd(), "ui/public/apple-touch-icon.png"));
    expect(png.byteLength).toBeLessThan(256 * 1024);
    const pngBase64 = png.toString("base64");
    const responses = {
      "/workspace/notes.txt": previewResponse("notes.txt", {
        content: "Exact-head workspace preview proof.\n",
        contentEncoding: "utf8",
        hash: "a".repeat(64),
        mimeType: "text/plain",
        previewKind: "text",
        size: 36,
      }),
      "/workspace/openclaw.png": previewResponse("openclaw.png", {
        content: pngBase64,
        contentEncoding: "base64",
        mimeType: "image/png",
        previewKind: "image",
        size: png.byteLength,
      }),
      "/workspace/unsupported-binary.bmp": previewResponse("unsupported-binary.bmp", {
        mimeType: "image/bmp",
        previewKind: "unsupported",
        size: 4096,
      }),
    } satisfies Record<string, Record<string, unknown>>;
    await withPage(async (page) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.files.get": {
            cases: Object.entries(responses).map(([requestPath, response]) => ({
              match: { path: requestPath },
              response,
            })),
          },
          "sessions.files.list": {
            browser: {
              entries: Object.keys(responses).map((requestPath) => {
                const filePath = requestPath.slice("/workspace/".length);
                return { kind: "file", name: filePath, path: filePath };
              }),
              path: "",
            },
            files: [],
            root: "/workspace",
            sessionKey,
          },
        },
      });
      const openPreview = async (filePath: string) => {
        await openChatSidePanelType(page, "Files");
        await page
          .getByRole("complementary", { name: "Session workspace", exact: true })
          .getByRole("button", { name: filePath, exact: true })
          .click();
      };
      const closePreview = async (filePath: string) => {
        await exactButton(page, `Close tab: ${filePath}`).click();
        await page.locator("openclaw-chat-detail-panel").waitFor({ state: "detached" });
      };

      await page.goto(`${suite.server.baseUrl}chat`);
      await openPreview("notes.txt");
      await page.locator(".sidebar-file-view").waitFor({ state: "visible" });
      expect(await page.locator(".cm-content").textContent()).toContain(
        "Exact-head workspace preview proof.",
      );
      await closePreview("notes.txt");

      await openPreview("openclaw.png");
      const image = page.getByRole("img", { name: "openclaw.png", exact: true });
      await image.waitFor({ state: "visible" });
      expect(await image.getAttribute("src")).toBe(`data:image/png;base64,${pngBase64}`);
      await expect
        .poll(() =>
          image.evaluate((element) => {
            const img = element as HTMLImageElement;
            return img.complete && img.naturalWidth > 0 && img.naturalHeight > 0;
          }),
        )
        .toBe(true);
      await closePreview("openclaw.png");

      await openPreview("unsupported-binary.bmp");
      const fallback = page.locator(".sidebar-file-view");
      const status = fallback.getByRole("status");
      await status.waitFor({ state: "visible" });
      expect(await status.textContent()).toContain("Preview unavailable");
      expect(await status.textContent()).toContain("Download this file to view it on your device.");
      expect(await fallback.getByLabel("unsupported-binary.bmp", { exact: true }).isVisible()).toBe(
        true,
      );
      expect(
        await status.getByRole("button", { name: "Download file", exact: true }).isVisible(),
      ).toBe(true);
      expect(await fallback.locator("img, iframe").count()).toBe(0);

      expect(
        (await gateway.getRequests("sessions.files.get")).map((request) => request.params),
      ).toEqual([
        fileRequest("/workspace/notes.txt"),
        fileRequest("/workspace/openclaw.png"),
        fileRequest("/workspace/unsupported-binary.bmp"),
      ]);
    });
  });

  it("previews skill source on hover, focus, and touch without leaving the chat", async () => {
    const source =
      "---\nname: release-notes\ndescription: Write concise release notes from verified changes.\n---\n\n# Release notes\n\nRead the source, then describe the user-visible changes.\n" +
      "\nMore instructions.".repeat(410) +
      "\nEnd of the full skill.";
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 768, height: 1024 },
      { width: 1366, height: 768 },
      { width: 1440, height: 900 },
    ]) {
      await suite.withPage(
        { viewport, hasTouch: viewport.width === 390, colorScheme: "dark" },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            historyMessages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: "Inspect the [release-notes skill](skills/release-notes/SKILL.md).",
                  },
                ],
                timestamp: 1,
              },
            ],
            methodResponses: {
              "skills.files.get": {
                path: "skills/release-notes/SKILL.md",
                name: "release-notes",
                content: source,
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          const link = page.locator('a[data-file-path="skills/release-notes/SKILL.md"]');
          await link.waitFor();
          if (viewport.width === 390) {
            await link.tap();
          } else {
            await link.hover();
          }
          const card = page.getByRole("dialog", { name: "Skill file preview" });
          const code = card.getByLabel("Skill source");
          await code.waitFor();
          await polledCount(page.locator("openclaw-tooltip[open]")).toBe(0);
          expect(await code.textContent()).toContain("Read the source");
          expect(await code.locator(".skill-file-hovercard__line").count()).toBe(400);
          expect(await code.textContent()).not.toContain("End of the full skill.");
          const bounds = await card.boundingBox();
          expect(bounds).not.toBeNull();
          expect(bounds!.x).toBeGreaterThanOrEqual(0);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
          expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
          expect(await code.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
          // The hover bridge keeps the preview available for selection and scrolling.
          await code.hover();
          await code.click();
          await page.keyboard.press("End");
          await page.keyboard.press("Escape");
          await card.waitFor({ state: "detached" });
          expect(await link.evaluate((el) => el === document.activeElement)).toBe(true);
          await link.press("Enter");
          await code.waitFor();
          await link.press("Tab");
          expect(
            await card
              .getByRole("button", { name: "Copy file" })
              .evaluate((el) => el === document.activeElement),
          ).toBe(true);
          await card.getByRole("button", { name: "Open full file" }).click();
          const fileView = page.locator(".sidebar-file-view");
          await fileView.waitFor();
          const sourceButton = fileView
            .getByRole("button", { name: "Source", exact: true })
            .filter({ visible: true });
          if (await sourceButton.isVisible()) {
            await sourceButton.click();
          } else {
            const readingMode = fileView
              .getByRole("button", { name: /^Reading mode:/ })
              .filter({ visible: true });
            if (await readingMode.isVisible()) {
              await readingMode.click();
              await fileView
                .getByRole("menuitemradio", { name: "Highlighted source", exact: true })
                .click();
            } else {
              await selectFileAction(fileView, "Highlighted source");
            }
          }
          await fileView.locator(".cm-scroller").hover();
          await page.mouse.wheel(0, 30_000);
          await polledText(page.locator(".cm-content")).toContain("End of the full skill.");
          expect((await gateway.getRequests("skills.files.get")).length).toBe(2);
          expect(await gateway.getRequests("sessions.files.get")).toHaveLength(0);
        },
      );
    }
  });
});
