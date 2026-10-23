import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  expectRequestCount,
  nativeAuth,
  terminalSession,
} from "./workspace-terminal.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI terminal file upload",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

const expectUploadSurface = process.env.OPENCLAW_TERMINAL_UPLOAD_EXPECT_PRESENT !== "0";

suite.define(() => {
  it.skipIf(!expectUploadSurface)(
    "pastes native catalog upload paths without treating the CLI title as a shell",
    async () => {
      await suite.withPage(
        { serviceWorkers: "block", viewport: { width: 1280, height: 800 } },
        async ({ page }) => {
          await nativeAuth(page);
          const nativeTitle = "claude --resume 12345678…";
          const stagedPath = "/tmp/openclaw-terminal-upload/reviewer's notes.pdf";
          const gateway = await installMockGateway(page, {
            featureMethods: ["terminal.open", "terminal.upload"],
            methodResponses: {
              "terminal.list": { sessions: [] },
              "terminal.open": terminalSession("terminal-native-upload-e2e", {
                shell: nativeTitle,
                title: nativeTitle,
              }),
            },
            terminalEnabled: true,
          });

          await page.goto(`${suite.server.baseUrl}focus/terminal`);
          await gateway.waitForRequest("terminal.open");
          await page.locator("button.tp-upload").waitFor({ state: "visible" });
          await expect
            .poll(() => page.locator(".tabstrip-tab.is-live").textContent())
            .toContain(nativeTitle);

          await gateway.deferNext("terminal.upload");
          await page.locator("input.tp-file-input").setInputFiles({
            name: "reviewer's notes.pdf",
            mimeType: "application/pdf",
            buffer: Buffer.from("%PDF"),
          });
          const upload = await gateway.waitForRequest("terminal.upload");
          expect(upload.params).toEqual({
            sessionId: "terminal-native-upload-e2e",
            name: "reviewer's notes.pdf",
            contentBase64: "JVBERg==",
          });
          await gateway.resolveDeferred("terminal.upload", {
            path: stagedPath,
            size: 4,
            uploadPathStyle: "native",
          });

          await expectRequestCount(gateway, "terminal.input", 1);
          const input = (await gateway.getRequests("terminal.input"))[0]?.params as {
            data?: string;
          };
          expect(input.data).toBe('"/tmp/openclaw-terminal-upload/reviewer\'s notes.pdf"');
          expect(input.data).not.toMatch(/[\r\n]/);
          await expect.poll(async () => await page.locator(".tp-upload-card").count()).toBe(0);
          expect(await gateway.getRequests("terminal.upload")).toHaveLength(1);
        },
      );
    },
  );

  it("uploads picked and dropped files, then pastes staged paths without Enter", async () => {
    await suite.withPage(
      {
        serviceWorkers: "block",
        viewport: { width: 1280, height: 800 },
      },
      async ({ page }) => {
        await nativeAuth(page);
        const stagedPath = "/tmp/openclaw-terminal-upload/sample file.pdf";
        const stagedNotesPath = "/tmp/openclaw-terminal-upload/notes.txt";
        const stagedDropPath = "/tmp/openclaw-terminal-upload/dropped.png";
        const gateway = await installMockGateway(page, {
          deferredMethods: ["connect"],
          featureMethods: ["terminal.open", "terminal.upload"],
          methodResponses: {
            "terminal.list": { sessions: [] },
            "terminal.open": terminalSession("terminal-upload-e2e"),
            "terminal.upload": { path: stagedPath, size: 4 },
          },
          terminalEnabled: true,
        });

        await page.goto(`${suite.server.baseUrl}focus/terminal`);
        await gateway.waitForRequest("connect");
        await gateway.resolveDeferred("connect");
        await gateway.waitForRequest("terminal.open");

        const addFiles = page.locator("button.tp-upload");
        if (!expectUploadSurface) {
          expect(await addFiles.count()).toBe(0);

          return;
        }

        await addFiles.waitFor({ state: "visible" });
        expect(await addFiles.isEnabled()).toBe(true);

        await gateway.deferNext("terminal.upload");
        await page.locator("input.tp-file-input").setInputFiles([
          { name: "sample file.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF") },
          { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("note") },
        ]);
        await expectRequestCount(gateway, "terminal.upload", 1, 10_000);
        await page.getByText("Uploading 1 of 2").waitFor();
        const progress = page.locator(".tp-upload-progress");
        await expect.poll(async () => await progress.getAttribute("aria-valuenow")).toBe("0");
        await expect.poll(async () => await progress.getAttribute("aria-valuemax")).toBe("2");

        await gateway.deferNext("terminal.upload");
        await gateway.resolveDeferred("terminal.upload", { path: stagedPath, size: 4 });
        await expectRequestCount(gateway, "terminal.upload", 2, 10_000);
        await page.getByText("Uploading 2 of 2").waitFor();
        await expect.poll(async () => await progress.getAttribute("aria-valuenow")).toBe("1");
        const relativeLockDirectory = ".openclaw\\tmp\\openclaw\\terminal-upload-lock";
        const privatePath = "C:\\Users\\operator\\private\\request.log";
        const recoveryMessage =
          "terminal upload staging is busy; retry after other uploads finish. " +
          `If it stays blocked after a crash, locate ${relativeLockDirectory} under the home directory ` +
          "of the account running this terminal's Gateway or node host. Stop all Gateway and " +
          "node-host processes using that staging root, remove only this lock directory, then restart them.";
        await gateway.rejectDeferred("terminal.upload", {
          code: "UNAVAILABLE",
          message: `${recoveryMessage} Diagnostic: ${privatePath}; token=synthetic-terminal-secret-value`,
        });
        await page.getByText("Upload failed").waitFor();
        const uploadError = page.locator(".tp-upload-card__error");
        await expect.poll(async () => await uploadError.textContent()).toContain(recoveryMessage);
        const displayedError = await uploadError.textContent();
        expect(displayedError).toContain(privatePath);
        expect(displayedError).not.toContain("synthetic-terminal-secret-value");
        expect(await page.getByRole("button", { name: "Retry" }).isVisible()).toBe(true);
        expect((await gateway.getRequests("terminal.input")).length).toBe(0);

        await gateway.setMethodResponse("terminal.upload", { path: stagedNotesPath, size: 4 });
        await page.getByRole("button", { name: "Retry" }).click();
        await expectRequestCount(gateway, "terminal.upload", 3, 10_000);
        const pickedUploads = await gateway.getRequests("terminal.upload");
        expect(pickedUploads.slice(0, 3).map((request) => request.params)).toEqual([
          {
            sessionId: "terminal-upload-e2e",
            name: "sample file.pdf",
            contentBase64: "JVBERg==",
          },
          {
            sessionId: "terminal-upload-e2e",
            name: "notes.txt",
            contentBase64: "bm90ZQ==",
          },
          {
            sessionId: "terminal-upload-e2e",
            name: "notes.txt",
            contentBase64: "bm90ZQ==",
          },
        ]);
        await expectRequestCount(gateway, "terminal.input", 1, 10_000);
        const pickedInput = (await gateway.getRequests("terminal.input"))[0]?.params as {
          data?: string;
        };
        expect(pickedInput.data).toContain("'/tmp/openclaw-terminal-upload/sample file.pdf'");
        expect(pickedInput.data).toContain("/tmp/openclaw-terminal-upload/notes.txt");
        expect(pickedInput.data).not.toMatch(/[\r\n]/);

        await gateway.setMethodResponse("terminal.upload", { path: stagedDropPath, size: 3 });
        await page.locator(".tp-viewport").evaluate((target) => {
          const transfer = new DataTransfer();
          transfer.items.add(new File([new Uint8Array([1, 2, 3])], "dropped.png"));
          target.dispatchEvent(
            new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }),
          );
          target.dispatchEvent(
            new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
          );
        });
        await expectRequestCount(gateway, "terminal.upload", 4, 10_000);
        const droppedUpload = (await gateway.getRequests("terminal.upload")).at(-1);
        expect(droppedUpload?.params).toEqual({
          sessionId: "terminal-upload-e2e",
          name: "dropped.png",
          contentBase64: "AQID",
        });
        await expectRequestCount(gateway, "terminal.input", 2, 10_000);
        const droppedInput = (await gateway.getRequests("terminal.input")).at(-1)?.params as {
          data?: string;
        };
        expect(droppedInput.data).toContain("/tmp/openclaw-terminal-upload/dropped.png");
        expect(droppedInput.data).not.toMatch(/[\r\n]/);

        await gateway.setMethodResponse("terminal.upload", { path: stagedPath, size: 4 });
        await gateway.deferNext("terminal.upload", { name: "blocked.zip" });
        await page.locator("input.tp-file-input").setInputFiles([
          { name: "sample file.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF") },
          { name: "blocked.zip", mimeType: "application/zip", buffer: Buffer.from("zip") },
        ]);
        await page.getByText("Uploading 2 of 2").waitFor();
        await expectRequestCount(gateway, "terminal.upload", 6);
        await gateway.rejectDeferred("terminal.upload", {
          code: "UNAVAILABLE",
          message: "Terminal upload staging is full. Move or remove staged files, then retry.",
        });
        const insertUploaded = page.getByRole("button", { name: "Insert uploaded paths" });
        await insertUploaded.waitFor({ state: "visible" });
        expect((await gateway.getRequests("terminal.input")).length).toBe(2);
        await insertUploaded.click();
        await expectRequestCount(gateway, "terminal.input", 3);
        const recoveredInput = (await gateway.getRequests("terminal.input")).at(-1)?.params as {
          data?: string;
        };
        expect(recoveredInput.data).toContain("'/tmp/openclaw-terminal-upload/sample file.pdf'");
        expect(recoveredInput.data).not.toContain("blocked.zip");
        expect(recoveredInput.data).not.toMatch(/[\r\n]/);
        expect((await gateway.getRequests("terminal.upload")).length).toBe(6);
        await expect.poll(async () => await page.locator(".tp-upload-card").count()).toBe(0);

        await gateway.deferNext("terminal.upload");
        await page.locator("input.tp-file-input").setInputFiles({
          name: "cancelled.zip",
          mimeType: "application/zip",
          buffer: Buffer.from("zip"),
        });
        await expectRequestCount(gateway, "terminal.upload", 7, 10_000);
        await page.getByText("Uploading 1 of 1").waitFor();
        await page.getByRole("button", { name: "Cancel" }).click();
        await expect.poll(async () => await page.locator(".tp-upload-card").count()).toBe(0);
        await gateway.resolveDeferred("terminal.upload", {
          path: "/tmp/openclaw-terminal-upload/cancelled.zip",
          size: 3,
        });
        await page.waitForTimeout(100);
        expect((await gateway.getRequests("terminal.input")).length).toBe(3);
      },
    );
  });
});
