import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "session companion clear",
  startServerBeforeBrowser: true,
});

const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
let artifactDir: string | undefined;
beforeEach(() => {
  artifactDir = artifactRoot
    ? createControlUiE2eArtifactDir("chat-session-companion-clear", artifactRoot)
    : undefined;
});
const answer = "Keep this companion answer visible until the reset succeeds.";
const initiatingSessionKey = "agent:main:companion-clear";
const nextSessionKey = "agent:main:companion-next";
const resetError = "Companion reset unavailable during reconnect";

type CompanionSurface = {
  clearButton: Locator;
  companion: Locator;
  gateway: MockGatewayControls;
  page: Page;
};

async function withCompanion(run: (surface: CompanionSurface) => Promise<void>): Promise<void> {
  await suite.withPage(
    {
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 800, width: 1200 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 800, width: 1200 } } }
        : {}),
    },
    async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.companion.reset": {
            __mockError: { code: "UNAVAILABLE", message: resetError },
          },
          "sessions.companion.state": {
            cases: [
              {
                match: { sessionKey: initiatingSessionKey },
                response: {
                  exchanges: [{ question: "What changed?", answer, ts: Date.now() - 1_000 }],
                },
              },
              { match: { sessionKey: nextSessionKey }, response: { exchanges: [] } },
            ],
          },
          "sessions.list": {
            count: 2,
            defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
            path: "",
            sessions: [
              { key: initiatingSessionKey, kind: "direct", label: "Original", updatedAt: 2 },
              { key: nextSessionKey, kind: "direct", label: "Next", updatedAt: 1 },
            ],
            ts: Date.now(),
          },
        },
        sessionKey: initiatingSessionKey,
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, initiatingSessionKey));
      const stateRequest = await gateway.waitForRequest("sessions.companion.state");
      expect(stateRequest.params).toEqual({
        agentId: "main",
        sessionKey: initiatingSessionKey,
      });
      await openChatSidePanelType(page, "Side chat");
      const companion = page.locator("openclaw-chat-session-rail");
      await companion.getByText(answer, { exact: true }).waitFor();
      // The embedded rail has no header of its own: its destructive clear is
      // contributed to the shared side-panel header by the active panel.
      const clearButton = page.getByRole("button", { name: "Clear side chat", exact: true });
      await run({ clearButton, companion, gateway, page });
    },
  );
}

async function clearCompanion(clearButton: Locator): Promise<void> {
  await clearButton.click();
}

suite.define(() => {
  it("preserves the thread on reset failure and a newer draft after a successful retry", async () => {
    await withCompanion(async ({ clearButton, companion, gateway, page }) => {
      await clearCompanion(clearButton);
      await gateway.waitForRequest("sessions.companion.reset");

      const alert = page.getByRole("alert").filter({ hasText: resetError });
      await alert.waitFor({ state: "visible" });
      await companion.getByText(answer, { exact: true }).waitFor();
      if (artifactDir) {
        await writeFile(
          path.join(artifactDir, "reset-failure.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [alert, companion]),
        );
      }

      await alert.getByRole("button", { name: "Dismiss error" }).click();
      await gateway.setMethodResponse("sessions.companion.reset", { ok: true });
      await gateway.deferNext("sessions.companion.reset");
      await clearCompanion(clearButton);

      await expect
        .poll(async () => (await gateway.getRequests("sessions.companion.reset")).length)
        .toBe(2);
      const input = companion.getByRole("textbox", { name: "Ask in side chat", exact: true });
      await input.fill("Keep the question I typed after Clear");
      await gateway.resolveDeferred("sessions.companion.reset", { ok: true });
      await expect.poll(() => companion.getByText(answer, { exact: true }).count()).toBe(0);
      expect(await input.inputValue()).toBe("Keep the question I typed after Clear");
      expect(await page.getByRole("alert").count()).toBe(0);
      if (artifactDir) {
        await writeFile(
          path.join(artifactDir, "reset-success.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [clearButton]),
        );
      }
    });
  });

  it("retains a question sent after Clear while its answer is pending", async () => {
    await withCompanion(async ({ clearButton, companion, gateway }) => {
      await gateway.deferNext("sessions.companion.reset");
      await clearCompanion(clearButton);
      await gateway.waitForRequest("sessions.companion.reset");
      await gateway.deferNext("sessions.companion.ask");
      const input = companion.getByRole("textbox", { name: "Ask in side chat", exact: true });
      await input.fill("Answer the question sent after Clear");
      await input.press("Enter");
      const request = await gateway.waitForRequest("sessions.companion.ask");
      expect(request.params).toMatchObject({ question: "Answer the question sent after Clear" });
      await gateway.resolveDeferred("sessions.companion.reset", { ok: true });
      await expect.poll(() => companion.getByText(answer, { exact: true }).count()).toBe(0);
      await companion.getByText("Answer the question sent after Clear", { exact: true }).waitFor();
      await gateway.resolveDeferred("sessions.companion.ask", {
        answer: "New answer retained",
        ts: 2,
      });
      await companion.getByText("New answer retained", { exact: true }).waitFor();
      expect(await input.inputValue()).toBe("");
    });
  });

  it.each(["pending", "completed"])(
    "retires a pre-Clear %s image without cancelling a newer image",
    async (oldRead) => {
      await withCompanion(async ({ clearButton, companion, gateway, page }) => {
        const reads = await page.evaluateHandle(() => {
          const NativeFileReader = FileReader;
          const pending = new Map<string, () => Promise<void>>();
          const aborted: string[] = [];
          globalThis.FileReader = class extends NativeFileReader {
            fileName = "";
            override readAsDataURL(blob: Blob): void {
              this.fileName = (blob as File).name;
              pending.set(
                this.fileName,
                () =>
                  new Promise<void>((resolve) => {
                    this.addEventListener("loadend", () => resolve(), { once: true });
                    super.readAsDataURL(blob);
                  }),
              );
            }
            override abort(): void {
              aborted.push(this.fileName);
              super.abort();
            }
          };
          return {
            aborted,
            finish: async (name: string) => {
              const read = pending.get(name);
              if (!read) {
                throw new Error(`No held read for ${name}`);
              }
              pending.delete(name);
              await read();
            },
          };
        });
        const input = companion.getByRole("textbox", { name: "Ask in side chat", exact: true });
        const paste = (name: string) =>
          input.evaluate((element, fileName) => {
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 1;
            const content = canvas.toDataURL("image/png").split(",")[1]!;
            const transfer = new DataTransfer();
            transfer.items.add(
              new File([Uint8Array.from(atob(content), (c) => c.charCodeAt(0))], fileName, {
                type: "image/png",
              }),
            );
            element.dispatchEvent(
              new ClipboardEvent("paste", {
                bubbles: true,
                cancelable: true,
                clipboardData: transfer,
              }),
            );
            return content;
          }, name);
        await input.fill("Old draft cleared even when an old image completes");
        await paste("old.png");
        await companion.getByRole("button", { name: "Remove old.png", exact: true }).waitFor();
        await gateway.deferNext("sessions.companion.reset");
        await clearCompanion(clearButton);
        await gateway.waitForRequest("sessions.companion.reset");
        if (oldRead === "completed") {
          await reads.evaluate((proof) => proof.finish("old.png"));
          await companion.getByRole("img", { name: "old.png", exact: true }).waitFor();
        }
        const newImage = await paste("new.png");
        await companion.getByRole("button", { name: "Remove new.png", exact: true }).waitFor();
        await gateway.resolveDeferred("sessions.companion.reset", { ok: true });
        await expect.poll(() => companion.getByText(answer, { exact: true }).count()).toBe(0);
        expect(await input.inputValue()).toBe("");
        expect(await reads.evaluate((proof) => proof.aborted)).toEqual(
          oldRead === "pending" ? ["old.png"] : [],
        );
        if (oldRead === "pending") {
          await reads.evaluate((proof) => proof.finish("old.png"));
        }
        await reads.evaluate((proof) => proof.finish("new.png"));
        await companion.getByRole("img", { name: "new.png", exact: true }).waitFor();
        expect(
          await companion.getByRole("button", { name: "Remove old.png", exact: true }).count(),
        ).toBe(0);
        await input.fill("Send only the image added after Clear");
        await input.press("Enter");
        const request = await gateway.waitForRequest("sessions.companion.ask");
        expect(request.params).toMatchObject({
          attachments: [{ fileName: "new.png", content: newImage }],
        });
        expect((request.params as { attachments: unknown[] }).attachments).toHaveLength(1);
      });
    },
  );

  it("does not publish a delayed reset rejection into a newly selected session", async () => {
    await withCompanion(async ({ clearButton, gateway, page }) => {
      await gateway.deferNext("sessions.companion.reset");
      await clearCompanion(clearButton);
      await gateway.waitForRequest("sessions.companion.reset");

      await navigateToControlUiSession(page, nextSessionKey);
      await gateway.rejectDeferred("sessions.companion.reset", {
        code: "UNAVAILABLE",
        message: resetError,
      });

      const visiblePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible");
      expect(await visiblePane.getByRole("alert").filter({ hasText: resetError }).count()).toBe(0);
      if (artifactDir) {
        await writeFile(
          path.join(artifactDir, "stale-reset-error-suppressed.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
            visiblePane.locator(".agent-chat__composer-combobox textarea"),
          ]),
        );
      }

      await navigateToControlUiSession(page, initiatingSessionKey);
      const initiatingPane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible");
      expect(await initiatingPane.getByRole("alert").filter({ hasText: resetError }).count()).toBe(
        0,
      );
      await initiatingPane
        .locator("openclaw-chat-session-rail")
        .getByText(answer, { exact: true })
        .waitFor();
      if (artifactDir) {
        await writeFile(
          path.join(artifactDir, "initiating-thread-preserved.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
            initiatingPane.locator("openclaw-chat-session-rail").getByText(answer, { exact: true }),
          ]),
        );
      }
    });
  });
});
