import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { closeChatLayoutMenu, openChatLayoutMenu } from "../test-helpers/chat-layout-menu.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails, openChatDetails } from "./chat-details.test-support.ts";
import { exactButton } from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "session companion clear",
  startServerBeforeBrowser: true,
});

const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
const answer = "Keep this companion answer visible until the reset succeeds.";
const sessionKey = "agent:main:companion-clear";
const nextSessionKey = "agent:main:companion-next";
const resetError = "Companion reset unavailable during reconnect";

async function withCompanion(
  run: (surface: Awaited<ReturnType<typeof companionSurface>>) => Promise<void>,
  width = 1200,
): Promise<void> {
  const artifactDir = artifactRoot
    ? createControlUiE2eArtifactDir("chat-session-companion-clear", artifactRoot)
    : undefined;
  await suite.withPage(
    {
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 800, width },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 800, width: 1200 } } }
        : {}),
    },
    async ({ page }) => run(await companionSurface(page, artifactDir)),
  );
}

async function companionSurface(page: Page, artifactDir: string | undefined) {
  const gateway = await installMockGateway(page, {
    methodResponses: {
      "sessions.companion.reset": {
        __mockError: { code: "UNAVAILABLE", message: resetError },
      },
      "sessions.companion.state": {
        cases: [sessionKey, nextSessionKey].map((key) => ({
          match: { sessionKey: key },
          response: {
            exchanges: key === sessionKey ? [{ question: "What changed?", answer, ts: 1 }] : [],
          },
        })),
      },
    },
    sessions: [
      { key: sessionKey, kind: "direct", label: "Original", updatedAt: 2 },
      { key: nextSessionKey, kind: "direct", label: "Next", updatedAt: 1 },
    ],
    sessionKey,
  });

  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
  const stateRequest = await gateway.waitForRequest("sessions.companion.state");
  expect(stateRequest.params).toEqual({ agentId: "main", sessionKey });
  await openChatSidePanelType(page, "Side chat");
  const companion = page.locator("openclaw-chat-session-rail");
  const text = (value: string) => companion.getByText(value, { exact: true });
  await text(answer).waitFor();
  const input = companion.getByRole("textbox", { name: "Ask in side chat", exact: true });
  const clear = async (defer = false) => {
    if (defer) {
      await gateway.deferNext("sessions.companion.reset");
    }
    await openChatLayoutMenu(page);
    await page.getByRole("button", { name: "Clear side chat", exact: true }).click();
    await closeChatLayoutMenu(page);
    await gateway.waitForRequest("sessions.companion.reset");
  };
  const finishClear = async () => {
    await gateway.resolveDeferred("sessions.companion.reset", { ok: true });
    await expect.poll(() => text(answer).count()).toBe(0);
  };
  const capture = async (name: string, elements: Locator[]) => {
    if (artifactDir) {
      await writeFile(
        path.join(artifactDir, `${name}.png`),
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), elements),
      );
    }
  };
  return { clear, finishClear, companion, input, text, gateway, page, capture };
}

suite.define(() => {
  it.each([1200, 390])(
    "preserves the thread on reset failure and a newer draft after a successful retry at %ipx",
    async (width) => {
      await withCompanion(
        async ({ clear, finishClear, companion, input, text, gateway, page, capture }) => {
          await clear();

          const alert = page.getByRole("alert").filter({ hasText: resetError });
          await alert.waitFor({ state: "visible" });
          await text(answer).waitFor();
          await capture("reset-failure", [alert, companion]);

          await openChatDetails(page);
          await closeChatDetails(page);
          await alert.getByRole("button", { name: "Dismiss error" }).click();
          await clear(true);

          await expect
            .poll(async () => (await gateway.getRequests("sessions.companion.reset")).length)
            .toBe(2);
          await input.fill("Keep the question I typed after Clear");
          await finishClear();
          expect(await input.inputValue()).toBe("Keep the question I typed after Clear");
          expect(await page.getByRole("alert").count()).toBe(0);
          await capture("reset-success", [companion]);
        },
        width,
      );
    },
  );

  it("retains a question sent after Clear while its answer is pending", async () => {
    await withCompanion(async ({ clear, finishClear, input, text, gateway }) => {
      const question = "Answer the question sent after Clear";
      await clear(true);
      await gateway.deferNext("sessions.companion.ask");
      await input.fill(question);
      await input.press("Enter");
      const request = await gateway.waitForRequest("sessions.companion.ask");
      expect(request.params).toMatchObject({ question });
      await finishClear();
      await text(question).waitFor();
      await gateway.resolveDeferred("sessions.companion.ask", {
        answer: "New answer retained",
        ts: 2,
      });
      await text("New answer retained").waitFor();
      expect(await input.inputValue()).toBe("");
    });
  });

  it.each(["pending", "completed"])(
    "retires a pre-Clear %s image without cancelling a newer image",
    async (oldRead) => {
      await withCompanion(async ({ clear, finishClear, companion, input, gateway, page }) => {
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
          return { aborted, finish: (name: string) => pending.get(name)!() };
        });
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
        await exactButton(companion, "Remove old.png").waitFor();
        await clear(true);
        if (oldRead === "completed") {
          await reads.evaluate((proof) => proof.finish("old.png"));
          await companion.getByRole("img", { name: "old.png", exact: true }).waitFor();
        }
        const newImage = await paste("new.png");
        await exactButton(companion, "Remove new.png").waitFor();
        await finishClear();
        expect(await input.inputValue()).toBe("");
        expect(await reads.evaluate((proof) => proof.aborted)).toEqual(
          oldRead === "pending" ? ["old.png"] : [],
        );
        if (oldRead === "pending") {
          await reads.evaluate((proof) => proof.finish("old.png"));
        }
        await reads.evaluate((proof) => proof.finish("new.png"));
        await companion.getByRole("img", { name: "new.png", exact: true }).waitFor();
        expect(await exactButton(companion, "Remove old.png").count()).toBe(0);
        await input.fill("Send only the image added after Clear");
        await input.press("Enter");
        const request = await gateway.waitForRequest("sessions.companion.ask");
        expect(request.params).toMatchObject({
          attachments: [{ fileName: "new.png", content: newImage }],
        });
        expect(request.params).toHaveProperty("attachments.length", 1);
      });
    },
  );

  it("does not publish a delayed reset rejection into a newly selected session", async () => {
    await withCompanion(async ({ clear, gateway, page, capture }) => {
      await clear(true);

      await navigateToControlUiSession(page, nextSessionKey);
      await gateway.rejectDeferred("sessions.companion.reset", {
        code: "UNAVAILABLE",
        message: resetError,
      });

      const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible");
      const error = pane.getByRole("alert").filter({ hasText: resetError });
      expect(await error.count()).toBe(0);
      await capture("stale-reset-error-suppressed", [
        pane.locator(".agent-chat__composer-combobox textarea"),
      ]);

      await navigateToControlUiSession(page, sessionKey);
      expect(await error.count()).toBe(0);
      const preservedAnswer = pane
        .locator("openclaw-chat-session-rail")
        .getByText(answer, { exact: true });
      await preservedAnswer.waitFor();
      await capture("initiating-thread-preserved", [preservedAnswer]);
    });
  });
});
