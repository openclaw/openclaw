import { readFile, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { createDeferredCore } from "../../../src/shared/deferred.ts";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
suite.define(() => {
  it("hands original small and large files to the browser from Files and previews", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const files = [
      { name: "release report.md", bytes: Buffer.from("# Release report\r\nReady. 🦞\r\n") },
      { name: "large.txt", bytes: Buffer.alloc(16 * 1024 * 1024, "x") },
    ];
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.files.list": {
          sessionKey: "agent:main:main",
          root: "/workspace/project",
          files: [],
          browser: {
            path: "",
            entries: [
              { kind: "directory", name: "reports", path: "reports" },
              ...files.map((file) => ({
                kind: "file",
                name: file.name,
                path: file.name,
                size: file.bytes.length,
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
          if (req.url === "/api/artifacts/download/e2e/file") {
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
    const parent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifacts = parent
      ? createControlUiE2eArtifactDir("file-stream-downloads", parent)
      : undefined;
    const capture = async (surface: Locator, name: string) => {
      if (!artifacts) {
        return;
      }
      const frame = await takeControlUiScreenshotFrame(page, surface, [surface], {
        elements: [surface],
        animations: "disabled",
      });
      await writeFile(path.join(artifacts, name), frame.elements[0]!.png);
    };
    const save = async (button: Locator) => {
      expect(await button.isEnabled()).toBe(true);
      releaseBody = createDeferredCore();
      transferFinished = false;
      const pending = page.waitForEvent("download");
      await button.click();
      const download = await pending;
      // Saving begins while the body is deliberately held. A fetch/blob path cannot do this.
      expect(transferFinished).toBe(false);
      expect(download.url()).toBe(baseUrl + "api/artifacts/download/e2e/file");
      releaseBody.resolve();
      expect(download.suggestedFilename()).toBe(selected.name);
      const saved = await download.path();
      expect(saved).toBeTruthy();
      expect((await readFile(saved!)).equals(selected.bytes)).toBe(true);
      expect(await download.failure()).toBeNull();
    };
    try {
      await page.goto(baseUrl + "chat");
      const originalUrl = page.url();
      await openChatSidePanelType(page, "Files");
      const rail = page.locator(".chat-workspace-rail");
      expect(
        await rail
          .getByRole("listitem")
          .filter({ hasText: "reports" })
          .getByRole("button", { name: "Download file" })
          .count(),
      ).toBe(0);
      for (const file of files) {
        selected = file;
        await gateway.setMethodResponse("sessions.files.download", {
          filename: file.name,
          mimeType: "text/plain",
          url: "/api/artifacts/download/e2e/file",
          expiresAt: "2099-01-01T00:00:00Z",
        });
        const row = rail.getByRole("listitem").filter({ hasText: file.name });
        const button = row.getByRole("button", { name: "Download file", exact: true });
        await button.hover();
        const beforePreviewReads = (await gateway.getRequests("sessions.files.get")).length;
        if (file === files[0]) {
          const before = await gateway.deferNext("sessions.files.download");
          await button.click();
          await gateway.waitForRequest("sessions.files.download", { after: before });
          await gateway.rejectDeferred("sessions.files.download", {
            code: "FORBIDDEN",
            message: "File access denied",
          });
          await page.getByText(/Could not download this file:.*File access denied/).waitFor();
        } else {
          await capture(rail, "large-list.png");
        }
        await save(button);
        expect((await gateway.getRequests("sessions.files.get")).length).toBe(beforePreviewReads);
        const before = await gateway.deferNext("sessions.files.get");
        await row.getByRole("button", { name: "Preview", exact: true }).click();
        await gateway.waitForRequest("sessions.files.get", { after: before });
        if (file === files[0]) {
          await gateway.resolveDeferred("sessions.files.get", {
            sessionKey: "agent:main:main",
            root: "/workspace/project",
            file: {
              path: file.name,
              name: file.name,
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
          .filter({ has: page.getByRole("button", { name: "Download file", exact: true }) });
        await preview.waitFor();
        if (file !== files[0]) {
          await capture(preview, "large-preview.png");
        }
        await save(preview.getByRole("button", { name: "Download file", exact: true }));
        await preview.getByRole("button", { name: "Show in Files", exact: true }).click();
      }
      expect(await gateway.getRequests("sessions.files.download")).toHaveLength(5);
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
