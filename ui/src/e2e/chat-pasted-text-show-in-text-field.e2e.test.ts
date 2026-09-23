import { readFile } from "node:fs/promises";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForCommittedComposerDraft } from "./settle.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI pasted text chips",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const pastedText = `Quarterly launch plan\n\n  Preserve indentation 🦞\n${"x".repeat(1100)}`;
const pastedTextLabel = "Quarterly launch plan Preserve…";
const contextOptions = {
  locale: "en-US",
  reducedMotion: "reduce" as const,
  serviceWorkers: "block" as const,
  permissions: ["clipboard-read", "clipboard-write"],
  viewport: { height: 900, width: 1280 },
};

async function paste(composer: Locator) {
  await composer.evaluate((element, text) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", text);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }),
    );
  }, pastedText);
}

suite.define(() => {
  it.each([1280, 390])("restores pasted text directly from the %ipx composer", async (width) => {
    await suite.withPage(
      { ...contextOptions, viewport: { width, height: 900 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}chat`);
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor({ state: "visible" });
        await composer.fill("Keep this draft");
        await paste(composer);
        await page.locator(".agent-chat__file-input").setInputFiles({
          name: "launch-preview.html",
          mimeType: "text/html",
          buffer: Buffer.from("<!doctype html><title>Preview</title>"),
        });
        await page
          .locator(".chat-attachment-file__name", { hasText: "launch-preview.html" })
          .waitFor();
        const pastedCard = page.locator(
          ".chat-attachments-preview openclaw-chat-pasted-text .chat-attachment-thumb--file",
        );
        await pastedCard.getByRole("button", { name: pastedTextLabel, exact: true }).waitFor();
        for (const theme of ["dark", "light"]) {
          await page.evaluate((mode) => {
            document.documentElement.dataset.themeMode = mode;
          }, theme);
          expect(
            await pastedCard.evaluate((card) => {
              const other = document.querySelector(
                ".chat-attachments-preview .chat-attachment-thumb--file:not(openclaw-chat-pasted-text *)",
              )!;
              const name = card.querySelector(".chat-attachment-file__name")!;
              const action = card.querySelector(".chat-attachment-text-action")!;
              const rect = card.getBoundingClientRect();
              const actionRect = action.getBoundingClientRect();
              const style = getComputedStyle(card);
              const otherStyle = getComputedStyle(other);
              return {
                sameSize:
                  rect.width === other.getBoundingClientRect().width &&
                  rect.height === other.getBoundingClientRect().height,
                sameBorder:
                  style.border === otherStyle.border &&
                  style.borderRadius === otherStyle.borderRadius,
                secondRow: actionRect.top >= name.getBoundingClientRect().bottom,
                inside:
                  actionRect.left >= rect.left &&
                  actionRect.right <= rect.right &&
                  actionRect.bottom < rect.bottom,
                readable: action.clientWidth >= action.scrollWidth,
                nestedControls: card.querySelectorAll(
                  "button button, button a, [role=button] button",
                ).length,
              };
            }),
          ).toEqual({
            sameSize: true,
            sameBorder: true,
            secondRow: true,
            inside: true,
            readable: true,
            nestedControls: 0,
          });
        }
        const restore = pastedCard.getByRole("button", {
          name: "Show in text field",
          exact: true,
        });
        await restore.focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => composer.inputValue()).toBe(`Keep this draft\n\n${pastedText}`);
        expect(
          await page.locator(".chat-attachments-preview openclaw-chat-pasted-text").count(),
        ).toBe(0);
        expect(
          await page
            .locator(".chat-attachment-file__name", { hasText: "launch-preview.html" })
            .count(),
        ).toBe(1);
        expect(await page.locator("openclaw-chat-detail-panel:visible").count()).toBe(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      },
    );
  });

  it("opens the exact pasted text by keyboard, copies it, and returns it to the text field", async () => {
    await suite.withPage(contextOptions, async ({ page }) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible" });
      await paste(composer);
      const chip = page.getByRole("button", { name: pastedTextLabel, exact: true });
      await chip.focus();
      await page.keyboard.press("Enter");
      const preview = page.locator("openclaw-chat-detail-panel:visible");
      await preview.waitFor({ state: "visible" });
      expect(await page.locator("openclaw-chat-pasted-text openclaw-tooltip").count()).toBe(0);
      const content = preview.locator(".sidebar-attachment-preview__text");
      await expect.poll(() => content.textContent()).toBe(pastedText);
      expect(await content.evaluate((element) => getComputedStyle(element).fontFamily)).toMatch(
        /mono/i,
      );
      await preview.getByRole("button", { name: "Copy", exact: true }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(pastedText);
      await preview.getByRole("button", { name: "Show in text field", exact: true }).click();
      await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(0);
      await expect.poll(() => composer.inputValue()).toBe(pastedText);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });

  it.each([
    { name: "recorded paste", legacy: false },
    { name: "legacy paste without origin", legacy: true },
  ])("restores a $name draft as a chip and sends unchanged name and bytes", async ({ legacy }) => {
    await suite.withPage(contextOptions, async ({ page }) => {
      const sessionKey = "agent:main:main";
      const gateway = await installMockGateway(page, { sessionKey });
      await page.goto(`${suite.server.baseUrl}chat?session=${encodeURIComponent(sessionKey)}`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible" });
      await paste(composer);
      const scopeKey = `chat:v3:${sessionKey}\u0000agent:main`;
      await waitForCommittedComposerDraft(page, scopeKey, "", 1);
      const fileName = await page.evaluate(
        async ({ scopeKey: storedScopeKey, legacy: restoreLegacy }) => {
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("openclaw-control-ui");
            request.addEventListener("success", () => resolve(request.result), { once: true });
            request.addEventListener(
              "error",
              () => reject(request.error ?? new Error("Could not open composer draft database")),
              { once: true },
            );
          });
          try {
            return await new Promise<string>((resolve, reject) => {
              const transaction = database.transaction(
                "composerDrafts",
                restoreLegacy ? "readwrite" : "readonly",
              );
              const store = transaction.objectStore("composerDrafts");
              const request = store.getAll() as IDBRequest<
                Array<{
                  scopeKey: string;
                  attachments: Array<{ fileName: string; origin?: string }>;
                }>
              >;
              let savedFileName: string | undefined;
              request.addEventListener(
                "success",
                () => {
                  const draft = request.result.find((record) => record.scopeKey === storedScopeKey);
                  const attachment = draft?.attachments[0];
                  if (!draft || !attachment) {
                    transaction.abort();
                    return;
                  }
                  savedFileName = attachment.fileName;
                  if (restoreLegacy) {
                    // Reproduce the persisted shape written before origin metadata existed.
                    delete attachment.origin;
                    store.put(draft);
                  }
                },
                { once: true },
              );
              transaction.addEventListener(
                "complete",
                () =>
                  savedFileName
                    ? resolve(savedFileName)
                    : reject(new Error("Missing persisted attachment")),
                { once: true },
              );
              transaction.addEventListener(
                "abort",
                () => reject(transaction.error ?? new Error("Draft fixture transaction aborted")),
                { once: true },
              );
              transaction.addEventListener(
                "error",
                () => reject(transaction.error ?? new Error("Draft fixture transaction failed")),
                { once: true },
              );
            });
          } finally {
            database.close();
          }
        },
        { scopeKey, legacy },
      );
      await page.reload();
      const chip = page.getByRole("button", { name: pastedTextLabel, exact: true });
      await chip.click();
      const preview = page.locator("openclaw-chat-detail-panel:visible");
      await expect
        .poll(() => preview.locator(".sidebar-attachment-preview__text").textContent())
        .toBe(pastedText);
      await composer.click();
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await expect.poll(async () => (await gateway.getRequests("chat.send")).length).toBe(1);
      const params = (await gateway.getRequests("chat.send"))[0]!.params;
      expect(params).toEqual(
        expect.objectContaining({
          attachments: [
            {
              type: "file",
              mimeType: "text/plain",
              fileName,
              ...(!legacy ? { origin: "paste" } : {}),
              content: Buffer.from(pastedText).toString("base64"),
            },
          ],
        }),
      );
      expect(fileName).toMatch(/^pasted-text-\d+\.txt$/);
    });
  });

  it("keeps a newly uploaded lookalike filename as a file and sends file origin", async () => {
    await suite.withPage(contextOptions, async ({ page }) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".agent-chat__file-input").setInputFiles({
        name: "pasted-text-123.txt",
        mimeType: "text/plain",
        buffer: Buffer.from(pastedText),
      });
      await page
        .locator(".chat-attachment-file__name", { hasText: "pasted-text-123.txt" })
        .waitFor();
      expect(await page.locator("openclaw-chat-pasted-text").count()).toBe(0);
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await expect.poll(async () => (await gateway.getRequests("chat.send")).length).toBe(1);
      expect((await gateway.getRequests("chat.send"))[0]!.params).toEqual(
        expect.objectContaining({
          attachments: [
            {
              type: "file",
              mimeType: "text/plain",
              fileName: "pasted-text-123.txt",
              origin: "file",
              content: Buffer.from(pastedText).toString("base64"),
            },
          ],
        }),
      );
    });
  });

  it("projects persisted origins and legacy names into ordered chips and ordinary file cards", async () => {
    await suite.withPage(contextOptions, async ({ page }) => {
      const comment =
        "Selected text:\nReview this\n\nUser comment:\nKeep spacing.\n\nSource session: agent:main:main\nSelected text UTF-16 length: 11\nDOM text UTF-16 range: [0, 11)";
      const fact = (text: string, fileName: string, origin?: "paste" | "file") => ({
        url: `data:text/plain;base64,${Buffer.from(text).toString("base64")}`,
        contentType: "text/plain",
        fileName,
        ...(origin ? { origin } : {}),
      });
      const retryUrl = `${suite.server.baseUrl}pasted-note-retry.txt`;
      let sourceAvailable = false;
      await page.route(retryUrl, (route) => {
        return route.fulfill({
          status: sourceAvailable ? 200 : 503,
          contentType: "text/plain; charset=utf-8",
          body: sourceAvailable ? pastedText : "Temporarily unavailable",
        });
      });
      await installMockGateway(page, {
        historyMessages: [
          {
            role: "user",
            content: "Please review the attached notes.",
            timestamp: 1,
            __openclaw: {
              media: [
                fact(comment, "selection-comment.txt", "file"),
                { ...fact(pastedText, "renamed-note.md", "paste"), url: retryUrl },
                fact("Legacy pasted text", "pasted-text-123.txt"),
              ],
            },
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Next attachments" }],
            timestamp: 2,
          },
          {
            role: "user",
            content: "",
            timestamp: 3,
            __openclaw: {
              media: [
                fact("Chosen file", "pasted-text-123.txt", "file"),
                fact("Ordinary historical text", "pasted-text-other.txt"),
              ],
            },
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const chips = page.locator(".chat-thread-inner .chat-selection-annotations__chip");
      await expect.poll(() => chips.count()).toBe(3);
      await expect.poll(() => chips.nth(2).textContent()).toContain("Legacy pasted text");
      const labels = (await chips.allTextContents()).map((label) => label.trim());
      expect(labels[0]).toMatch(/comment/i);
      expect(labels.slice(1)).toEqual(["Pasted text", "Legacy pasted text"]);
      const cards = page.locator(".chat-thread-inner .chat-assistant-attachment-card__title");
      await expect
        .poll(async () => (await cards.allTextContents()).map((label) => label.trim()))
        .toEqual(["pasted-text-123.txt", "pasted-text-other.txt"]);
      const shell = page
        .locator(".chat-bubble")
        .filter({ has: page.locator("openclaw-chat-pasted-text") });
      expect(await shell.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
        "rgba(0, 0, 0, 0)",
      );
      await expect
        .poll(() =>
          shell.evaluate((element) => {
            const text = element.querySelector(".chat-text")!;
            const body = text.getBoundingClientRect();
            const rects = Array.from(
              element.querySelectorAll(".chat-selection-annotations__chip"),
              (chip) => chip.getBoundingClientRect(),
            );
            return {
              above: rects.every((rect) => rect.bottom <= body.top),
              horizontal: rects.every((rect) => Math.abs(rect.top - rects[0]!.top) < 1),
              aligned: Math.abs(Math.max(...rects.map((rect) => rect.right)) - body.right) < 1,
              paintedText: getComputedStyle(text).backgroundColor !== "rgba(0, 0, 0, 0)",
            };
          }),
        )
        .toEqual({ above: true, horizontal: true, aligned: true, paintedText: true });
      await page.setViewportSize({ width: 390, height: 900 });
      await expect
        .poll(() =>
          shell.evaluate((element) => {
            const body = element.querySelector(".chat-text")!.getBoundingClientRect();
            const rects = Array.from(
              element.querySelectorAll(".chat-selection-annotations__chip"),
              (chip) => chip.getBoundingClientRect(),
            );
            return {
              above: rects.every((rect) => rect.bottom <= body.top),
              wrapped: rects.some((rect) => rect.top > rects[0]!.bottom),
              sharesRow: rects.some((rect, index) =>
                rects.some(
                  (other, otherIndex) => index !== otherIndex && Math.abs(rect.top - other.top) < 1,
                ),
              ),
              withinViewport: rects.every((rect) => rect.left >= 0 && rect.right <= innerWidth),
              aligned: Math.abs(Math.max(...rects.map((rect) => rect.right)) - body.right) < 1,
            };
          }),
        )
        .toEqual({
          above: true,
          wrapped: true,
          sharesRow: true,
          withinViewport: true,
          aligned: true,
        });
      await chips.nth(1).click();
      const preview = page.locator("openclaw-chat-detail-panel:visible");
      const retry = preview.getByRole("button", { name: "Retry", exact: true });
      await retry.waitFor();
      const download = preview.getByRole("link", { name: "Download renamed-note.md", exact: true });
      expect(await download.getAttribute("href")).toBe(retryUrl);
      expect(await download.getAttribute("download")).toBe("renamed-note.md");
      sourceAvailable = true;
      await retry.click();
      await expect
        .poll(() => preview.locator(".sidebar-attachment-preview__text").textContent())
        .toBe(pastedText);
      expect(await preview.locator("article").count()).toBe(0);
      expect((await chips.allTextContents()).map((label) => label.trim())).toEqual(labels);
    });
  });

  it("labels an oversized persisted inline paste and downloads every original byte", async () => {
    await suite.withPage(contextOptions, async ({ page }) => {
      const text = "  Preserve the original UTF-8 text 🦞\n".repeat(8_000);
      const bytes = Buffer.from(text, "utf8");
      const fileName = "pasted-text-987.txt";
      expect(bytes.length).toBeGreaterThan(256 * 1024);
      await installMockGateway(page, {
        historyMessages: [
          {
            role: "user",
            content: "",
            timestamp: 1,
            __openclaw: {
              media: [
                {
                  url: `data:text/plain;base64,${bytes.toString("base64")}`,
                  contentType: "text/plain",
                  fileName,
                  origin: "paste",
                  sizeBytes: bytes.length,
                },
              ],
            },
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await page
        .getByRole("button", { name: "Preserve the original UTF-8 te…", exact: true })
        .click();
      const preview = page.locator("openclaw-chat-detail-panel:visible");
      await preview
        .getByText(
          "Could not preview this file. Text previews require UTF-8 files up to 256 KiB. Download it to read the full file.",
          { exact: true },
        )
        .waitFor();
      const link = preview.getByRole("link", { name: `Download ${fileName}`, exact: true });
      expect(await link.getAttribute("download")).toBe(fileName);
      const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
      expect(download.suggestedFilename()).toBe(fileName);
      expect(await download.failure()).toBeNull();
      const file = await download.path();
      expect(file).not.toBeNull();
      expect(await readFile(file!)).toEqual(bytes);
    });
  });
});
