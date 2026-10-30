import type { Dialog, Frame, Page } from "playwright";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { selectFileAction } from "./chat-file-actions.test-support.ts";
import { chatMessage } from "./chat-flow.test-support.ts";
import { exactButton, twoFrames } from "./chat-presentation.test-support.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "File editor recovery" });

const editorContext = { viewport: { width: 1280, height: 900 } };
const fileEditorRequest = controlUiE2eBuiltModuleRequest(
  "ui/src/pages/chat/components/file-editor-view.ts",
);
async function expectEditor(page: Page, name: string) {
  const editor = page.locator(".cm-content:visible");
  await editor.waitFor();
  expect(await editor.textContent()).toContain(`Synthetic ${name} content`);
}

declare global {
  interface Window {
    editorInitAttempts?: number;
    editorInitMaySucceed?: boolean;
    rejectEditorInitialization?: () => void;
  }
}

async function replaceEditor(page: Page, body: (url: string) => string) {
  await page.route(fileEditorRequest, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("actual")) {
      await route.continue();
      return;
    }
    url.searchParams.set("actual", "1");
    await route.fulfill({ contentType: "text/javascript", body: body(url.href) });
  });
}

async function openFilePreview(page: Page) {
  const gateway = await installMockGateway(page, {
    featureMethods: [...defaultControlUiFeatureMethods, "sessions.files.set"],
    historyMessages: [
      chatMessage("assistant", "Review `notes.txt` and `other.txt`.", { timestamp: 1 }),
    ],
    methodResponses: {
      "sessions.files.get": {
        cases: ["notes.txt", "other.txt"].map((name) => ({
          match: { path: name },
          response: {
            sessionKey: "agent:main:main",
            root: "/workspace",
            file: {
              hash: "original-hash",
              previewKind: "text",
              contentEncoding: "utf8",
              content: `Synthetic ${name} content`,
              kind: "read",
              missing: false,
              name,
              path: name,
              workspacePath: name,
            },
          },
        })),
      },
      "sessions.files.set": {
        sessionKey: "agent:main:main",
        file: { hash: "saved-hash" },
      },
    },
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  await page.locator('a.markdown-file-link[data-file-path="notes.txt"]').click();
  return gateway;
}

suite.define(() => {
  it.each(["Save", "Discard"] as const)(
    "protects file drafts across browser reload and navigation until %s",
    async (settle) => {
      await suite.withPage(editorContext, async ({ page }) => {
        const gateway = await openFilePreview(page);
        const panel = page.locator(".sidebar-file-view:visible");
        const editor = page.locator(".cm-content:visible");
        await selectFileAction(panel, "Edit file");
        await editor.click();
        await editor.press("ControlOrMeta+End");
        await page.keyboard.type("\nKeep this unsaved paragraph.");
        const draft = "Synthetic notes.txt content\nKeep this unsaved paragraph.";
        expect(await exactButton(panel, "Save").isEnabled()).toBe(true);

        const reload = async () => {
          const session = await page.context().newCDPSession(page);
          const outcome = Promise.withResolvers<string | undefined>();
          const onDialog = (dialog: Dialog) => {
            void dialog.dismiss().then(() => outcome.resolve(dialog.type()), outcome.reject);
          };
          const onNavigation = (frame: Frame) => {
            if (frame === page.mainFrame()) {
              outcome.resolve(undefined);
            }
          };
          page.on("dialog", onDialog);
          page.on("framenavigated", onNavigation);
          try {
            // Cancellation has no navigation to await; observe the native outcome instead.
            await session.send("Page.reload");
            return await outcome.promise;
          } finally {
            page.off("dialog", onDialog);
            page.off("framenavigated", onNavigation);
            await session.detach();
          }
        };
        expect(await reload()).toBe("beforeunload");
        expect(await editor.locator(".cm-line").allTextContents()).toEqual(draft.split("\n"));
        await editor.press("End");
        await page.keyboard.type(" Continued after cancellation.");
        const continued = `${draft} Continued after cancellation.`;
        await page.getByRole("link", { name: "New conversation", exact: true }).first().click();
        await page.waitForURL(/\/new(?:\?|$)/);
        await editor.waitFor({ state: "hidden" });
        expect(await reload()).toBe("beforeunload");
        await page.goBack();
        await page.locator('a.markdown-file-link[data-file-path="notes.txt"]').click();
        await expect
          .poll(() => editor.locator(".cm-line").allTextContents())
          .toEqual(continued.split("\n"));
        await exactButton(panel, settle).click();
        if (settle === "Save") {
          await expect.poll(() => exactButton(panel, "Save").isDisabled()).toBe(true);
          expect((await gateway.getRequests("sessions.files.set")).at(-1)?.params).toMatchObject({
            content: continued,
            expectedHash: "original-hash",
          });
        } else {
          expect(await gateway.getRequests("sessions.files.set")).toEqual([]);
        }
        expect(await reload()).toBeUndefined();
        await page.locator('a.markdown-file-link[data-file-path="notes.txt"]').waitFor();
      });
    },
  );

  it("keeps initialization failures terminal until an explicit retry", async () => {
    await suite.withPage(editorContext, async ({ page }) => {
      await replaceEditor(
        page,
        (url) => `import { createFileEditorView as create } from ${JSON.stringify(url)};
              export async function createFileEditorView(options) {
                window.editorInitAttempts = (window.editorInitAttempts ?? 0) + 1;
                await new Promise(resolve => setTimeout(resolve, 25));
                if (!window.editorInitMaySucceed) throw new Error("Synthetic editor initialization failed");
                return create(options);
              }`,
      );
      await openFilePreview(page);
      await page.waitForFunction(
        () => document.querySelector(".lazy-view-error") || (window.editorInitAttempts ?? 0) >= 3,
      );
      expect(await page.locator(".lazy-view-error").count()).toBe(1);
      expect(await page.locator(".lazy-view-error").textContent()).toContain(
        "Synthetic editor initialization failed",
      );
      await page.evaluate(() => {
        window.editorInitMaySucceed = true;
        document.querySelector("openclaw-chat-detail-panel")!.basePath = "/incidental-redraw";
      });
      await twoFrames(page);
      expect(await page.evaluate(() => window.editorInitAttempts)).toBe(1);
      await page.locator(".lazy-view-error").getByRole("button", { name: /Retry/iu }).click();
      await expectEditor(page, "notes.txt");
      expect(await page.evaluate(() => window.editorInitAttempts)).toBe(2);
    });
  });
  it("reloads a missing editor chunk only after the gateway becomes reachable", async () => {
    await suite.withPage(editorContext, async ({ page }) => {
      let reachable = false;
      let chunkRequests = 0;
      let documentProbes = 0;
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route(new URL("index.html", suite.server.baseUrl).href, async (route) => {
        if (route.request().method() === "HEAD") {
          documentProbes += 1;
          await route.fulfill({ status: reachable ? 200 : 503, body: "" });
        } else {
          await route.continue();
        }
      });
      await page.route(fileEditorRequest, async (route) => {
        chunkRequests += 1;
        await (reachable
          ? route.continue()
          : route.fulfill({ status: 404, contentType: "text/javascript", body: "" }));
      });
      await openFilePreview(page);
      const failure = page.locator(".lazy-view-error--stale");
      await failure.waitFor();
      await expect.poll(() => documentProbes).toBe(1);
      expect(chunkRequests).toBe(1);
      expect(errors).toEqual([]);
      reachable = true;
      const navigation = page.waitForEvent("framenavigated", (frame) => frame === page.mainFrame());
      await exactButton(failure, "Reload").click();
      await navigation;
      await page.locator('a.markdown-file-link[data-file-path="notes.txt"]').click();
      await expectEditor(page, "notes.txt");
      expect(chunkRequests).toBe(2);
      expect(documentProbes).toBe(2);
      expect(errors).toEqual([]);
    });
  });

  it.each(["file", "close"] as const)(
    "keeps a late initialization failure scoped after selecting %s",
    async (selection) => {
      await suite.withPage(editorContext, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await replaceEditor(
          page,
          (url) => `import { createFileEditorView as create } from ${JSON.stringify(url)};
          export async function createFileEditorView(options) {
            if (window.rejectEditorInitialization) return create(options);
            await new Promise((_, reject) => window.rejectEditorInitialization = () => reject(new Error("Retired editor failed")));
          }`,
        );
        await openFilePreview(page);
        await page.waitForFunction(() => typeof window.rejectEditorInitialization === "function");
        if (selection === "file") {
          await page.locator('a.markdown-file-link[data-file-path="other.txt"]').click();
          await expectEditor(page, "other.txt");
        } else {
          await exactButton(page, "Close tab: notes.txt").click();
        }
        await page.evaluate(() => window.rejectEditorInitialization!());
        await twoFrames(page);
        expect(await page.locator(".lazy-view-error:visible").count()).toBe(0);
        expect(errors).toEqual([]);
        if (selection === "file") {
          const tab = (name: string) =>
            page.locator(".side-panel__header .tabstrip-tab").filter({ hasText: name });
          expect(await page.locator(".lazy-view-error").count()).toBe(1);
          await tab("notes.txt").click();
          expect(await page.locator(".lazy-view-error:visible").textContent()).toContain(
            "Retired editor failed",
          );
          await tab("other.txt").click();
          await expectEditor(page, "other.txt");
        } else {
          expect(await page.locator("openclaw-chat-detail-panel").count()).toBe(0);
        }
      });
    },
  );
});
