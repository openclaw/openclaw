// Real-browser proof for opening workspace files from chat links and the workspace browser.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { beforeEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  defaultControlUiFeatureMethods,
  controlUiE2eWaitTimeoutMs,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
let artifactDir: string;
beforeEach(() => {
  artifactDir = createControlUiE2eArtifactDir("chat-file-links");
});

function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 40 150 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI chat file links", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("preserves domain/path text in user messages", async () => {
    const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      const text = "Please check the portal.example/service.test reference.";
      const gateway = await installMockGateway(page, {
        historyMessages: [{ role: "user", content: [{ type: "text", text }], timestamp: 1 }],
      });
      await page.goto(`${server.baseUrl}chat`);
      const bubble = page.locator(".chat-bubble").filter({ hasText: "Please check" });
      await bubble.waitFor({ state: "visible" });
      // Capture the original wrong-label state too, before asserting the fixed behavior.
      await bubble.screenshot({ path: path.join(artifactDir, "domain-path-message.png") });
      expect(await bubble.textContent()).toContain(text);
      expect(await bubble.locator("a[data-file-path]").count()).toBe(0);
      expect(await gateway.getRequests("sessions.files.get")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it.each(["file", "close", "list"] as const)(
    "shows a file tab before completion and honors the %s intent",
    async (intent) => {
      const context = await browser.newContext({
        recordVideo: captureUiProof
          ? { dir: artifactDir, size: { height: 900, width: 1280 } }
          : undefined,
        viewport: { height: 900, width: 1280 },
      });
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      try {
        const file = {
          root: "/workspace",
          sessionKey: "agent:main:main",
          file: {
            previewKind: "text",
            contentEncoding: "utf8",
            content: "export const loaded = true;\n",
            kind: "read",
            missing: false,
            name: "slow.ts",
            path: "src/slow.ts",
            workspacePath: "src/slow.ts",
          },
        };
        const gateway = await installMockGateway(page, {
          deferredMethods: [
            "sessions.files.get",
            ...(intent === "list" ? ["sessions.files.list"] : []),
          ],
          historyMessages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Review `src/slow.ts`." }],
              timestamp: 1,
            },
          ],
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
        const response = await page.goto(`${server.baseUrl}chat`);
        expect(response?.status()).toBe(200);
        const indexSha256 = createHash("sha256")
          .update(await response!.body())
          .digest("hex");
        if (intent === "list") {
          await openChatSidePanelType(page, "Files");
          await gateway.waitForRequest("sessions.files.list");
        }

        await page.locator('a.markdown-file-link[data-file-path="src/slow.ts"]').click();
        await gateway.waitForRequest("sessions.files.get");

        await page.locator('[data-region-header="side"]').waitFor({ state: "visible" });
        expect(await page.locator(".sidebar-file-view").count()).toBe(0);
        await page.screenshot({ path: path.join(artifactDir, "latency-panel-before-file.png") });

        const fileTab = page.locator(".side-panel__header wa-tab").filter({ hasText: "slow.ts" });
        expect(await fileTab.count()).toBe(1);
        if (intent === "close") {
          await page.getByRole("button", { name: "Close tab: slow.ts", exact: true }).click();
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
        // Capture either settled outcome before the strict assertion, including a failing baseline.
        if ((await fileView.count()) > 0) {
          await expect
            .poll(() => fileView.locator(".cm-content").textContent())
            .toContain("export const loaded = true;");
        }
        fs.writeFileSync(
          path.join(artifactDir, "intent-requests.json"),
          JSON.stringify(
            {
              intent,
              bundle: {
                indexSha256,
                assets: await page.evaluate(
                  "performance.getEntriesByType('resource').map(entry => new URL(entry.name).pathname).filter(path => path.includes('/assets/'))",
                ),
              },
              files: await gateway.getRequests("sessions.files.get"),
              lists: await gateway.getRequests("sessions.files.list"),
            },
            null,
            2,
          ),
        );
        await page.screenshot({ path: path.join(artifactDir, `intent-${intent}-settled.png`) });
        if (intent === "close") {
          expect(await fileTab.count()).toBe(0);
          expect(await page.locator(".sidebar-file-view").count()).toBe(0);
        } else {
          expect(await fileView.count()).toBe(1);
          expect(await fileView.locator(".cm-content").textContent()).toContain(
            "export const loaded = true;",
          );
        }
      } finally {
        await context.close();
      }
    },
  );

  it("previews a linked workspace PDF in the side panel", async () => {
    const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      const pdf = minimalPdf("Workspace brochure");
      const mediaRequests: URL[] = [];
      await page.route("**/__openclaw__/assistant-media?**", async (route) => {
        const url = new URL(route.request().url());
        mediaRequests.push(url);
        if (url.searchParams.get("meta") === "1") {
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              available: true,
              mimeType: "application/pdf",
              sizeBytes: pdf.length,
              mediaTicket: "ticket-pdf",
              mediaTicketExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            }),
          });
          return;
        }
        await route.fulfill({ contentType: "application/pdf", body: pdf });
      });
      await installMockGateway(page, {
        historyMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "The brochure is at `docs/brochure.pdf`." }],
            timestamp: 1,
          },
        ],
        methodResponses: {
          "sessions.files.get": {
            root: "/workspace",
            sessionKey: "agent:main:main",
            file: {
              kind: "read",
              missing: false,
              name: "brochure.pdf",
              path: "docs/brochure.pdf",
              workspacePath: "docs/brochure.pdf",
              mimeType: "application/pdf",
              previewKind: "unsupported",
              size: pdf.length,
            },
          },
        },
      });
      await page.goto(`${server.baseUrl}chat`);

      await page.locator('a.markdown-file-link[data-file-path="docs/brochure.pdf"]').click();

      const frame = page.locator(".sidebar-pdf-preview__frame");
      await frame.waitFor({ state: "visible" });
      await page.screenshot({ path: path.join(artifactDir, "workspace-pdf-preview.png") });
      expect(await page.getByText("This file is not previewable inline.").count()).toBe(0);
      const byteRequest = mediaRequests.find((url) => url.searchParams.get("meta") !== "1");
      expect(byteRequest?.searchParams.get("source")).toBe("/workspace/docs/brochure.pdf");
      expect(byteRequest?.searchParams.get("mediaTicket")).toBe("ticket-pdf");
    } finally {
      await context.close();
    }
  });

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
    const context = await browser.newContext({
      recordVideo: captureUiProof
        ? { dir: artifactDir, size: { height: 900, width: 1280 } }
        : undefined,
      viewport: { height: 900, width: 1280 },
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
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
                sessionKey: "agent:main:main",
                file: {
                  content: `// 1\n// 2\n// 3\n// 4\n// 5\n// 6\n${file.marker}\n`,
                  contentEncoding: "utf8",
                  kind: "read",
                  missing: false,
                  name: file.name,
                  path: file.workspacePath,
                  previewKind: "text",
                  workspacePath: file.workspacePath,
                },
              },
            })),
          },
        },
      });
      const response = await page.goto(`${server.baseUrl}chat`);
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
      // Keep the wrong-label baseline visible even when the final assertion fails.
      await page.screenshot({ path: path.join(artifactDir, "root-identity-links.png") });
      const opened = [];
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
        await expect
          .poll(() => fileView.locator(".cm-content").textContent())
          .toContain(file.marker);
        await expect
          .poll(() => fileView.locator(".file-view__line--target").getAttribute("data-line"))
          .toBe("7");
        opened.push({
          path: await fileView.locator(".sidebar-file-view__path").textContent(),
          content: await fileView.locator(".cm-content").textContent(),
          line: await fileView.locator(".file-view__line--target").getAttribute("data-line"),
        });
        await page.screenshot({
          path: path.join(artifactDir, `root-identity-file-${index + 1}.png`),
        });
        expect(page.url()).toBe(chatUrl);
        await page.getByRole("button", { name: `Close tab: ${file.name}`, exact: true }).click();
        await fileView.waitFor({ state: "detached" });
      }
      const requests = await gateway.getRequests("sessions.files.get");
      fs.writeFileSync(
        path.join(artifactDir, "root-identity.json"),
        JSON.stringify(
          {
            labels,
            requests,
            opened,
            indexSha256: response
              ? createHash("sha256")
                  .update(await response.body())
                  .digest("hex")
              : null,
          },
          null,
          2,
        ),
      );
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
        { agentId: "main", path: "/workspace/src/file.ts", sessionKey: "agent:main:main" },
        { agentId: "main", path: "workspace/src/file.ts", sessionKey: "agent:main:main" },
        ...files.slice(2).map((file) => ({
          agentId: "main",
          path: file.requestPath,
          sessionKey: "agent:main:main",
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
    } finally {
      await context.close();
    }
  });

  it("reveals and saves the selected file without losing Files search or focus", async () => {
    const context = await browser.newContext({
      recordVideo: captureUiProof
        ? { dir: artifactDir, size: { height: 900, width: 1280 } }
        : undefined,
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
    try {
      const initialText = "# Project\n\nNested workspace notes.\n";
      const initialSize = Buffer.byteLength(initialText, "utf8");
      const savedText = "# Project\n\nSaved workspace notes — café 雪 🦞.\n";
      const savedSize = Buffer.byteLength(savedText, "utf8");
      const listing = {
        root: "/workspace",
        sessionKey: "agent:main:main",
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
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "sessions.files.set", "sessions.diff"],
        historyMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Review `README.md:2`." }],
            timestamp: 1,
          },
        ],
        methodResponses: {
          "sessions.files.get": {
            cases: [
              {
                match: { path: "README.md" },
                response: {
                  root: "/workspace",
                  file: {
                    previewKind: "text",
                    contentEncoding: "utf8",
                    content: initialText,
                    hash: "before-hash",
                    kind: "modified",
                    missing: false,
                    name: "README.md",
                    path: "README.md",
                    workspacePath: "packages/app/README.md",
                  },
                },
              },
              {
                match: { path: "/workspace/packages/app/README.md" },
                response: {
                  root: "/workspace",
                  file: {
                    previewKind: "text",
                    contentEncoding: "utf8",
                    content: initialText,
                    hash: "before-hash",
                    kind: "modified",
                    missing: false,
                    name: "README.md",
                    path: "packages/app/README.md",
                    workspacePath: "packages/app/README.md",
                  },
                },
              },
            ],
          },
          "sessions.files.list": listing,
          "sessions.files.set": {
            sessionKey: "agent:main:main",
            file: { hash: "after-hash", size: savedSize },
          },
          "sessions.diff": {
            sessionKey: "agent:main:main",
            root: "/workspace",
            gitCheckout: true,
            files: [],
            additions: 0,
            deletions: 0,
          },
        },
      });

      await page.goto(`${server.baseUrl}chat`);
      await openChatSidePanelType(page, "Review");
      await gateway.waitForRequest("sessions.diff");
      await openChatSidePanelType(page, "Files");
      await page.getByRole("button", { name: "1 changed", exact: true }).click();
      const chatLink = page.locator('a.markdown-file-link[data-file-path="README.md"]');
      await chatLink.waitFor({ state: "visible" });
      await page.screenshot({ path: path.join(artifactDir, "01-chat-file-link.png") });
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
      await page.screenshot({ path: path.join(artifactDir, "02-chat-file-preview.png") });

      await fileView.getByRole("button", { name: "Show in Files" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.files.list")).at(-1)?.params)
        .toMatchObject({ path: "packages/app" });
      await expect
        .poll(() =>
          page.getByRole("button", { name: "All", exact: true }).getAttribute("aria-pressed"),
        )
        .toBe("true");
      const browserRow = page
        .locator(".chat-workspace-rail__list--browser .chat-workspace-rail__file")
        .filter({ hasText: "README.md" });
      await browserRow.locator(".chat-workspace-rail__file-open").click();
      await fileView.waitFor({ state: "visible" });
      expect(
        await page.locator(".side-panel__header wa-tab").filter({ hasText: "README.md" }).count(),
      ).toBe(1);
      const reads = await gateway.getRequests("sessions.files.get");
      expect(reads).toHaveLength(2);
      expect(reads[1]?.params).toMatchObject({ path: "/workspace/packages/app/README.md" });
      expect(await originalEditor!.evaluate((element) => element.isConnected)).toBe(true);
      expect(await fileView.locator(".file-view__line--target").getAttribute("data-line")).toBe(
        "2",
      );
      await page.screenshot({ path: path.join(artifactDir, "03-workspace-file-preview.png") });
      await page.locator('.side-panel__header button[aria-label="Files"]').click();
      const search = page.locator('.chat-workspace-rail input[type="search"]');
      await search.fill("README");
      await expect
        .poll(async () => (await gateway.getRequests("sessions.files.list")).at(-1)?.params)
        .toMatchObject({ search: "README" });
      await browserRow.locator(".chat-workspace-rail__file-open").click();
      await fileView.getByRole("button", { name: "Edit file", exact: true }).click();
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
      await fileView.getByRole("button", { name: "Save", exact: true }).click();
      await expect
        .poll(() => fileView.getByRole("button", { name: "Save", exact: true }).isDisabled())
        .toBe(true);
      expect((await gateway.getRequests("sessions.files.set")).at(-1)?.params).toMatchObject({
        content: savedText,
        expectedHash: "before-hash",
      });
      expect(await fileView.isVisible()).toBe(true);
      await page.getByRole("button", { name: "Close tab: README.md", exact: true }).click();
      await search.waitFor({ state: "visible" });
      expect(await search.inputValue()).toBe("README");
      const metadata = page.locator(".chat-workspace-rail__file-meta");
      try {
        await expect
          .poll(() => metadata.allTextContents())
          .toEqual([`${savedSize} B`, `packages/app/README.md / ${savedSize} B`]);
      } finally {
        await page.screenshot({ path: path.join(artifactDir, "04-saved-file-list.png") });
      }
    } finally {
      await context.close();
    }
  });

  it("previews text and images while offering a download for other binaries", async () => {
    const png = fs.readFileSync(path.resolve(process.cwd(), "ui/public/apple-touch-icon.png"));
    expect(png.byteLength).toBeLessThan(256 * 1024);
    const pngBase64 = png.toString("base64");
    const responses = {
      "/workspace/notes.txt": {
        root: "/workspace",
        sessionKey: "agent:main:main",
        file: {
          content: "Exact-head workspace preview proof.\n",
          contentEncoding: "utf8",
          hash: "a".repeat(64),
          kind: "read",
          mimeType: "text/plain",
          missing: false,
          name: "notes.txt",
          path: "notes.txt",
          previewKind: "text",
          size: 36,
          workspacePath: "notes.txt",
        },
      },
      "/workspace/openclaw.png": {
        root: "/workspace",
        sessionKey: "agent:main:main",
        file: {
          content: pngBase64,
          contentEncoding: "base64",
          kind: "read",
          mimeType: "image/png",
          missing: false,
          name: "openclaw.png",
          path: "openclaw.png",
          previewKind: "image",
          size: png.byteLength,
          workspacePath: "openclaw.png",
        },
      },
      "/workspace/unsupported-binary.bmp": {
        root: "/workspace",
        sessionKey: "agent:main:main",
        file: {
          kind: "read",
          mimeType: "image/bmp",
          missing: false,
          name: "unsupported-binary.bmp",
          path: "unsupported-binary.bmp",
          previewKind: "unsupported",
          size: 4096,
          workspacePath: "unsupported-binary.bmp",
        },
      },
    } satisfies Record<string, Record<string, unknown>>;
    const context = await browser.newContext({
      recordVideo: captureUiProof
        ? { dir: artifactDir, size: { height: 900, width: 1280 } }
        : undefined,
      viewport: { height: 900, width: 1280 },
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      await page.route("**/__openclaw__/assistant-media?**", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            available: true,
            mimeType: "image/bmp",
            sizeBytes: 4096,
            mediaTicket: "ticket-bmp",
            mediaTicketExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          }),
        }),
      );
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
            sessionKey: "agent:main:main",
          },
        },
      });
      const openPreview = async (filePath: string) => {
        const fileRow = page
          .locator(".chat-workspace-rail__list--browser .chat-workspace-rail__file")
          .filter({ hasText: filePath });
        await fileRow.locator(".chat-workspace-rail__file-open").click();
      };
      const closePreview = async (filePath: string) => {
        await page.getByRole("button", { name: `Close tab: ${filePath}`, exact: true }).click();
        await page.locator("openclaw-chat-detail-panel").waitFor({ state: "detached" });
      };

      await page.goto(`${server.baseUrl}chat`);
      await openChatSidePanelType(page, "Files");
      await page.getByRole("complementary", { name: "Session workspace" }).waitFor();

      await openPreview("notes.txt");
      await page.locator(".sidebar-file-view").waitFor({ state: "visible" });
      expect(await page.locator(".cm-content").textContent()).toContain(
        "Exact-head workspace preview proof.",
      );
      await page.screenshot({ path: path.join(artifactDir, "04-text-preview.png") });
      await closePreview("notes.txt");

      await openPreview("openclaw.png");
      const image = page.locator('.chat-tool-card__preview[data-kind="image"] img');
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
      await page.screenshot({ path: path.join(artifactDir, "05-png-preview.png") });
      await closePreview("openclaw.png");

      await openPreview("unsupported-binary.bmp");
      const download = page
        .locator(".sidebar-attachment-preview .chat-assistant-attachment-card")
        .filter({ hasText: "unsupported-binary.bmp" })
        .locator("a[download]");
      await download.waitFor({ state: "attached" });
      const downloadUrl = new URL((await download.getAttribute("href")) ?? "", server.baseUrl);
      expect(downloadUrl.pathname).toBe("/__openclaw__/assistant-media");
      expect(downloadUrl.searchParams.get("source")).toBe("/workspace/unsupported-binary.bmp");
      expect(downloadUrl.searchParams.get("mediaTicket")).toBe("ticket-bmp");
      await page.screenshot({ path: path.join(artifactDir, "06-bmp-download.png") });

      expect(
        (await gateway.getRequests("sessions.files.get")).map((request) => request.params),
      ).toEqual([
        { agentId: "main", path: "/workspace/notes.txt", sessionKey: "agent:main:main" },
        { agentId: "main", path: "/workspace/openclaw.png", sessionKey: "agent:main:main" },
        {
          agentId: "main",
          path: "/workspace/unsupported-binary.bmp",
          sessionKey: "agent:main:main",
        },
      ]);
    } finally {
      await context.close();
    }
  });
});
