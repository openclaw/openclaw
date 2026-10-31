import { createServer, request } from "node:http";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createDeferredCore } from "../../../src/shared/deferred.ts";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.ts";
import { readControlUiE2eDownload } from "../test-helpers/control-ui-e2e-download.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
suite.define(() => {
  it("hands original small and large files to the browser from their Files previews", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const files = [
      { name: "release report.md", bytes: Buffer.from("# Release report\r\nReady. 🦞\r\n") },
      { name: "large.txt", bytes: Buffer.alloc(16 * 1024 * 1024, "x") },
    ];
    const scope = { sessionKey: "agent:main:main", root: "/workspace/project" };
    const downloadPath = "/api/artifacts/download/e2e/file";
    const entry = (name: string) => ({ name, path: name });
    const gateway = await installMockGateway(page, {
      methodResponses: {
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
    const save = async (button: Locator) => {
      expect(await button.isEnabled()).toBe(true);
      releaseBody = createDeferredCore();
      transferFinished = false;
      const [download] = await Promise.all([page.waitForEvent("download"), button.click()]);
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
            hasText: /Could not download this file:.*File access denied/,
          });
          await denied.waitFor();
          await denied.getByRole("button", { name: "Dismiss", exact: true }).click();
          await denied.waitFor({ state: "hidden" });
        }
        await save(button);
        expect((await gateway.getRequests("sessions.files.get")).length).toBe(beforeDownloadReads);
      }
      expect(await gateway.getRequests("sessions.files.download")).toHaveLength(3);
      expect(await gateway.getRequests("sessions.files.get")).toHaveLength(2);
      expect(page.url()).toBe(originalUrl);
      expect(context.pages()).toHaveLength(1);
    } finally {
      releaseBody.resolve();
      await suite.closeBrowserContext(context);
      server.listener.closeAllConnections();
      await server.releaseListener();
      await server.claim.release();
    }
  });
});
