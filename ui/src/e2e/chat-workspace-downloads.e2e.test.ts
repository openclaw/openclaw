import { createServer, request } from "node:http";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createDeferredCore } from "../../../src/shared/deferred.ts";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.ts";
import { buildCatalogSessionKey, catalogSessionSearch } from "../lib/sessions/catalog-key.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import { readControlUiE2eDownload } from "../test-helpers/control-ui-e2e-download.ts";
import {
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { resumableClaudeCatalog } from "./claude-sessions.test-support.ts";
import {
  createControlUiE2eContextOptions,
  expandCodingSection,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
suite.define(() => {
  it("saves original files from previews and pending windowed Files rows", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    if (captureUiProofEnabled) {
      await context.tracing.start({ screenshots: true, snapshots: true });
    }
    const page = await context.newPage();
    const files = [
      { name: "release report.md", bytes: Buffer.from("# Release report\r\nReady. 🦞\r\n") },
      { name: "large.txt", bytes: Buffer.alloc(16 * 1024 * 1024, "x") },
    ];
    const scope = { sessionKey: "agent:main:main", root: "/workspace/project" };
    const downloadPath = "/api/artifacts/download/e2e/file";
    const entry = (name: string) => ({ name, path: name });
    const gateway = await installMockGateway(page, {
      featureMethods: [
        ...defaultControlUiFeatureMethods,
        "sessions.catalog.list",
        "sessions.catalog.read",
      ],
      methodResponses: {
        "sessions.catalog.list": resumableClaudeCatalog(),
        "sessions.catalog.read": {
          hostId: "gateway:local",
          threadId: "claude-terminal-session",
          items: [],
        },
        "sessions.files.list": {
          ...scope,
          files: [],
          browser: {
            path: "",
            entries: [
              { kind: "directory", ...entry("reports") },
              ...files.map(({ name, bytes }) => ({
                kind: "file",
                ...entry(name),
                size: bytes.length,
              })),
            ],
          },
        },
      },
    });
    let selected = files[0]!;
    let releaseBody = createDeferredCore();
    let transferFinished = false;
    // Native browser downloads bypass Playwright route interception. Serve a real
    // same-origin response and proxy the unchanged production UI to that origin.
    const server = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((req, res) => {
          if (req.url === downloadPath) {
            const file = selected;
            res.writeHead(200, {
              "content-type": "text/plain",
              "x-content-type-options": "nosniff",
              "content-length": file.bytes.length,
              "content-disposition": 'attachment; filename="' + file.name + '"',
            });
            res.write(file.bytes.subarray(0, 16));
            void releaseBody.promise.then(() => {
              transferFinished = true;
              res.end(file.bytes.subarray(16));
            });
            return;
          }
          const upstream = request(
            new URL(req.url ?? "/", suite.server.baseUrl),
            {
              method: req.method,
              headers: { ...req.headers, host: new URL(suite.server.baseUrl).host },
            },
            (response) => {
              res.writeHead(response.statusCode ?? 502, response.headers);
              response.pipe(res);
            },
          );
          upstream.on("error", () => res.destroy());
          res.once("close", () => upstream.destroy());
          req.pipe(upstream);
        }),
    });
    const baseUrl = "http://127.0.0.1:" + server.claim.port + "/";
    const save = async (start: () => Promise<unknown>) => {
      releaseBody = createDeferredCore();
      transferFinished = false;
      const [download] = await Promise.all([page.waitForEvent("download"), start()]);
      // Saving begins while the body is deliberately held. A fetch/blob path cannot do this.
      expect(transferFinished).toBe(false);
      expect(download.url()).toBe(new URL(downloadPath, baseUrl).href);
      releaseBody.resolve();
      expect(download.suggestedFilename()).toBe(selected.name);
      expect((await readControlUiE2eDownload(download)).equals(selected.bytes)).toBe(true);
      expect(await download.failure()).toBeNull();
    };
    try {
      await page.goto(baseUrl + "chat");
      const originalUrl = page.url();
      await openChatSidePanelType(page, "Files");
      const rail = page.locator(".workspace-desktop");
      const rowFor = (name: string) => rail.getByRole("listitem").filter({ hasText: name });
      const downloadButton = (surface: Locator | Page) =>
        surface.getByRole("button", { name: "Download file", exact: true });
      expect(await rowFor("reports").getByRole("button", { name: "Download file" }).count()).toBe(
        0,
      );
      for (const file of files) {
        if (file !== files[0]) {
          await page.getByRole("button", { name: "Toggle file tree", exact: true }).click();
        }
        selected = file;
        await gateway.setMethodResponse("sessions.files.download", {
          filename: file.name,
          mimeType: "text/plain",
          url: downloadPath,
          expiresAt: "2099-01-01T00:00:00Z",
        });
        const row = rowFor(file.name);
        const beforePreview = await gateway.deferNext("sessions.files.get");
        await row.getByRole("button", { name: file.name, exact: true }).click();
        await gateway.waitForRequest("sessions.files.get", { after: beforePreview });
        if (file === files[0]) {
          await gateway.resolveDeferred("sessions.files.get", {
            ...scope,
            file: {
              ...entry(file.name),
              kind: "read",
              missing: false,
              content: file.bytes.toString(),
              contentEncoding: "utf8",
              previewKind: "text",
              mimeType: "text/plain",
            },
          });
        } else {
          await gateway.rejectDeferred("sessions.files.get", {
            code: "INVALID_REQUEST",
            message: "session file is too large to preview",
            details: {
              type: "session_file_too_large",
              size: file.bytes.length,
              path: file.name,
              maxPreviewBytes: 256 * 1024,
            },
          });
        }
        const preview = page
          .locator(".chat-files-panel__page:visible")
          .filter({ has: downloadButton(page) });
        await preview.waitFor();
        // Oversized files expose the primary action in their unavailable-preview state.
        const button = downloadButton(
          file === files[0]
            ? preview.locator(".sidebar-file-view__path-bar")
            : preview.locator("openclaw-panel-empty-state"),
        );
        const beforeDownloadReads = (await gateway.getRequests("sessions.files.get")).length;
        if (file === files[0]) {
          const beforeDownload = await gateway.deferNext("sessions.files.download");
          await button.click();
          await gateway.waitForRequest("sessions.files.download", { after: beforeDownload });
          await gateway.rejectDeferred("sessions.files.download", {
            code: "FORBIDDEN",
            message: "File access denied",
          });
          const denied = page.locator(".app-toast").filter({
            hasText: /Couldn’t download this file\. Try again\..*File access denied/,
          });
          await denied.waitFor();
          await denied.getByRole("button", { name: "Dismiss", exact: true }).click();
          await denied.waitFor({ state: "hidden" });
        }
        expect(await button.isEnabled()).toBe(true);
        await save(() => button.click());
        expect((await gateway.getRequests("sessions.files.get")).length).toBe(beforeDownloadReads);
      }
      expect(await gateway.getRequests("sessions.files.download")).toHaveLength(3);
      expect(await gateway.getRequests("sessions.files.get")).toHaveLength(2);
      expect(page.url()).toBe(originalUrl);

      // A direct download does not select its row. Only the active operation
      // should retain it when scroll/focus moves the rendered window elsewhere.
      const filename = (index: number) => `file-${String(index).padStart(3, "0")}.md`;
      const catalog = {
        catalogId: "claude",
        hostId: "gateway:local",
        threadId: "claude-terminal-session",
      };
      await gateway.setMethodResponse("sessions.files.list", {
        ...scope,
        sessionKey: buildCatalogSessionKey(catalog, "main"),
        files: [],
        browser: {
          path: "",
          entries: Array.from({ length: 500 }, (_, index) => ({
            kind: "file",
            ...entry(filename(index)),
          })),
        },
      });
      // Catalog sessions select the native undefined-presentation Files owner.
      await expandCodingSection(page);
      await page
        .locator('[data-catalog-session-key^="catalog:claude:"]')
        .filter({ hasText: "Native Claude terminal" })
        .click();
      const catalogPane = page.locator("openclaw-chat-pane").filter({
        has: page.locator(
          `[data-chat-session-key=${JSON.stringify(buildCatalogSessionKey(catalog, "main"))}]`,
        ),
        visible: true,
      });
      // The retained old pane can still expose Files while the new route loads.
      await catalogPane
        .locator('.chat-pane__session-title[title="Native Claude terminal"]')
        .waitFor();
      const catalogRail = catalogPane
        .locator(".workspace-desktop--default")
        .filter({ visible: true });
      if (!(await catalogRail.isVisible())) {
        // The Files shortcut opens its slot even when the native side is empty.
        await page.keyboard.press("ControlOrMeta+Shift+B");
      }
      await catalogRail.waitFor();
      const catalogRow = (name: string) =>
        catalogRail.getByRole("listitem").filter({ hasText: name });
      const scroll = catalogRail.locator(".workspace-desktop__project-scroll");
      for (const [index, outcome] of ["save", "error"].entries()) {
        await scroll.evaluate((element) => (element.scrollTop = 0));
        const name = filename(index + 4);
        const row = catalogRow(name);
        const identity = row.getByRole("button", { name, exact: true });
        await identity.waitFor();
        expect(await identity.getAttribute("aria-current")).toBeNull();
        const beforeGrant = await gateway.deferNext("sessions.files.download");
        await downloadButton(row).click();
        await gateway.waitForRequest("sessions.files.download", { after: beforeGrant });
        await catalogRow(filename(499))
          .getByRole("button", { name: "Copy path", exact: true })
          .focus();
        await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        expect(await row.count()).toBe(1);
        expect(await catalogRail.getByRole("listitem").count()).toBeLessThan(80);
        expect(await identity.getAttribute("aria-current")).toBeNull();
        if (outcome === "save") {
          selected = { name, bytes: Buffer.from("Windowed download\r\n") };
          await save(() =>
            gateway.resolveDeferred("sessions.files.download", {
              filename: name,
              mimeType: "text/plain",
              url: downloadPath,
              expiresAt: "2099-01-01T00:00:00Z",
            }),
          );
        } else {
          await gateway.rejectDeferred("sessions.files.download", {
            code: "FORBIDDEN",
            message: "Windowed file access denied",
          });
          const denied = page
            .locator(".app-toast")
            .filter({ hasText: "Windowed file access denied" });
          await denied.waitFor();
          await denied.getByRole("button", { name: "Dismiss", exact: true }).click();
        }
        // Save/error settlement releases the pin; unrelated rows stay windowed.
        await row.waitFor({ state: "detached" });
      }
      expect(await gateway.getRequests("sessions.files.download")).toHaveLength(5);
      expect(await gateway.getRequests("sessions.files.get")).toHaveLength(2);
      expect(new URL(page.url()).search).toBe(catalogSessionSearch(catalog));
      expect(context.pages()).toHaveLength(1);
    } finally {
      releaseBody.resolve();
      if (captureUiProofEnabled) {
        await context.tracing.stop({
          path: path.join(suite.artifactDir, "files-downloads-trace.zip"),
        });
      }
      await suite.closeBrowserContext(context);
      server.listener.closeAllConnections();
      await server.releaseListener();
      await server.claim.release();
    }
  });
});
