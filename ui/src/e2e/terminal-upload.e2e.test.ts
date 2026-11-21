import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
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

// Trusted OS-level paste shortcut: the browser builds the ClipboardEvent itself.
const nativePasteShortcut = process.platform === "darwin" ? "Meta+V" : "Control+V";

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
        await page.getByText("Couldn’t add the file.", { exact: true }).waitFor();
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

  it.skipIf(!expectUploadSurface)(
    "stages a pasted clipboard image in the chat terminal composer and submits only on Send",
    async () => {
      await suite.withPage(
        {
          locale: "en-US",
          permissions: ["clipboard-read", "clipboard-write"],
          serviceWorkers: "block",
          viewport: { width: 1440, height: 900 },
        },
        async ({ page }) => {
          const sessionKey = "agent:main:dashboard:11111111-1111-4111-8111-111111111111";
          const gateway = await installMockGateway(page, {
            sessionKey,
            sessions: [
              createControlUiSessionRow(sessionKey, "Paste image chat", 1_790_000_000_000),
            ],
            featureMethods: [...defaultControlUiFeatureMethods, "terminal.open", "terminal.upload"],
            methodResponses: {
              "terminal.upload": { path: "/tmp/openclaw-terminal-upload/pasted.png", size: 3 },
            },
            terminalEnabled: true,
          });

          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await waitForControlUiGatewayReady(page);
          const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
          await openChatSidePanelType(pane, "Terminal");
          // The embedded chat terminal opens on its session picker; pick the
          // already-owned session so the composer mounts in the embedded panel.
          const embedded = pane.locator(".sidebar-region__right-runtime openclaw-terminal-panel");
          await embedded.locator(".tp-session.is-current").click();
          const composer = embedded.locator("form.tp-composer input");
          await composer.waitFor({ state: "visible" });

          // Encode a real PNG in the browser so the paste carries genuine image bytes.
          const pngBase64 = await page.evaluate(async () => {
            const canvas = document.createElement("canvas");
            canvas.width = 24;
            canvas.height = 16;
            const context = canvas.getContext("2d")!;
            context.fillStyle = "#c82828";
            context.fillRect(0, 0, canvas.width, canvas.height);
            const blob = await new Promise<Blob>((resolve) => {
              canvas.toBlob((encoded) => resolve(encoded!), "image/png");
            });
            const bytes = new Uint8Array(await blob.arrayBuffer());
            let binary = "";
            for (const byte of bytes) {
              binary += String.fromCharCode(byte);
            }
            return btoa(binary);
          });
          const copyPngToClipboard = async () => {
            await page.evaluate(async (image) => {
              const bytes = Uint8Array.from(atob(image), (char) => char.charCodeAt(0));
              await navigator.clipboard.write([
                new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) }),
              ]);
            }, pngBase64);
          };

          // A text-only clipboard paste stays on the native input path: the draft receives
          // the text and the upload owner admits nothing.
          await page.evaluate(async () => {
            await navigator.clipboard.write([
              new ClipboardItem({ "text/plain": new Blob(["echo hi"], { type: "text/plain" }) }),
            ]);
          });
          await composer.click();
          await page.keyboard.press(nativePasteShortcut);
          await expect.poll(() => composer.inputValue()).toBe("echo hi");
          expect(await gateway.getRequests("terminal.upload")).toHaveLength(0);

          await composer.fill("cat");

          // A trusted native paste of that real PNG, delivered by the browser to the
          // shipped composer input: the upload owner admits it instead of the input.
          await copyPngToClipboard();
          await composer.click();
          await page.keyboard.press(nativePasteShortcut);

          await expectRequestCount(gateway, "terminal.upload", 1, 10_000);
          const pastedUpload = (await gateway.getRequests("terminal.upload"))[0]?.params as {
            name: string;
            contentBase64: string;
          };
          // Chromium re-encodes clipboard images, so assert the delivered PNG container
          // and geometry rather than byte equality with the copied file.
          const stagedBytes = Buffer.from(pastedUpload.contentBase64, "base64");
          expect(stagedBytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
          expect(stagedBytes.readUInt32BE(16)).toBe(24);
          expect(stagedBytes.readUInt32BE(20)).toBe(16);
          expect(pastedUpload.name).toMatch(/\.png$/i);
          const chip = embedded.locator(".tp-attachment");
          await chip.waitFor({ state: "visible" });
          await expect.poll(() => chip.textContent()).toContain(pastedUpload.name);
          // The attachment is editable before submission: the composer draft survives.
          expect(await composer.inputValue()).toBe("cat");
          expect((await gateway.getRequests("terminal.input")).length).toBe(0);

          await embedded.locator(".tp-composer__submit").click();
          // Paste line plus Enter arrive as terminal.input requests only after Send.
          await expectRequestCount(gateway, "terminal.input", 2, 10_000);
          const sentData = (await gateway.getRequests("terminal.input"))
            .map((request) => (request.params as { data?: string }).data ?? "")
            .join("");
          expect(sentData).toContain("cat /tmp/openclaw-terminal-upload/pasted.png");
          expect(sentData).toContain("\r");
          expect(sentData.replace("\r", "")).not.toMatch(/[\r\n]/);
          await expect.poll(() => chip.count()).toBe(0);
        },
      );
    },
  );
});
