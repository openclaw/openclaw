import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "../../../src/gateway/control-ui-csp.ts";
import { readControlUiE2eDownload } from "../test-helpers/control-ui-e2e-download.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  seedChatSettings,
  splitColumns,
  splitTranscripts,
} from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForCommittedComposerDraft } from "./settle.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI pasted text chips",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const nativePasteShortcut = process.platform === "darwin" ? "Meta+V" : "Control+V";
const pastedText = `Quarterly launch plan\n\n  Preserve indentation 🦞\n${"x".repeat(1100)}`;
const pastedTextLabel = "Quarterly launch plan Preserve…";
const contextOptions = {
  locale: "en-US",
  reducedMotion: "reduce" as const,
  serviceWorkers: "block" as const,
  permissions: ["clipboard-read", "clipboard-write"],
  viewport: { height: 900, width: 1280 },
};
const fact = (
  text: string,
  fileName: string,
  origin?: "paste" | "file",
  extra: { url?: string; sizeBytes?: number } = {},
) => ({
  url: `data:text/plain;base64,${Buffer.from(text).toString("base64")}`,
  contentType: "text/plain",
  fileName,
  ...(origin ? { origin } : {}),
  ...extra,
});

const button = (root: Page | Locator, name: string) =>
  root.getByRole("button", { name, exact: true });
const expectPastedText = (preview: Locator) =>
  expect
    .poll(() => preview.locator(".sidebar-attachment-preview__text").textContent())
    .toBe(pastedText);
const history = <T extends ReturnType<typeof fact>>(media: T[], content = "", timestamp = 1) => ({
  role: "user" as const,
  content,
  timestamp,
  __openclaw: { media },
});

function historyLayout(element: Element, mobile: boolean) {
  const text = element.querySelector(".chat-text")!;
  const body = text.getBoundingClientRect();
  const rects = Array.from(element.querySelectorAll(".chat-selection-annotations__chip"), (chip) =>
    chip.getBoundingClientRect(),
  );
  return {
    above: rects.every((rect) => rect.bottom <= body.top),
    aligned: Math.abs(Math.max(...rects.map((rect) => rect.right)) - body.right) < 1,
    ...(mobile
      ? {
          wrapped: rects.some((rect) => rect.top > rects[0]!.bottom),
          sharesRow: rects.some((rect, index) =>
            rects.some(
              (other, otherIndex) => index !== otherIndex && Math.abs(rect.top - other.top) < 1,
            ),
          ),
          withinViewport: rects.every((rect) => rect.left >= 0 && rect.right <= innerWidth),
        }
      : {
          horizontal: rects.every((rect) => Math.abs(rect.top - rects[0]!.top) < 1),
          paintedText: getComputedStyle(text).backgroundColor !== "rgba(0, 0, 0, 0)",
        }),
  };
}

async function paste(composer: Locator) {
  await composer.evaluate((element, text) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", text);
    element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
    );
  }, pastedText);
}

suite.define(() => {
  it.each(["text", "image"] as const)(
    "routes a native %s paste from the session transcript into its composer",
    async (kind) => {
      await suite.withPage(contextOptions, async ({ page }) => {
        const rows = ["a", "b"].map((suffix) => ({
          key: `agent:main:paste-${suffix}`,
          kind: "direct",
          label: `Paste session ${suffix}`,
          updatedAt: 1,
        }));
        if (kind === "image") {
          await seedChatSettings(page, suite.server.baseUrl, {
            chatSplitLayout: splitColumns(rows, 0),
          });
        }
        const gateway = await installMockGateway(page, {
          historyMessages: [{ role: "assistant", content: "Paste a copied note or image here." }],
          ...(kind === "image"
            ? {
                sessionKey: rows[0]!.key,
                sessions: rows,
                sessionTranscripts: splitTranscripts(rows),
              }
            : {}),
        });
        await page.goto(`${suite.server.baseUrl}chat${kind === "image" ? "/main/paste-a" : ""}`);
        const composers = page.locator(".agent-chat__composer-combobox textarea");
        await expect.poll(() => composers.count()).toBe(kind === "image" ? 2 : 1);
        const composer = composers.last();
        await composer.waitFor({ state: "visible" });
        await composer.fill("");
        if (kind === "image") {
          await composers.first().fill("Keep the other session draft.");
        }
        await page.evaluate(async (contentKind) => {
          if (contentKind === "text") {
            await navigator.clipboard.writeText("A copied note for this session.");
            return;
          }
          const canvas = document.createElement("canvas");
          canvas.width = 160;
          canvas.height = 100;
          const context = canvas.getContext("2d")!;
          context.fillStyle = "#4c82f7";
          context.fillRect(0, 0, canvas.width, canvas.height);
          const png = await new Promise<Blob>((resolve) => {
            canvas.toBlob((blob) => resolve(blob!));
          });
          await navigator.clipboard.write([
            new ClipboardItem({
              "image/png": png,
              "text/plain": new Blob(["Image clipboard fallback"], { type: "text/plain" }),
            }),
          ]);
        }, kind);
        const transcript = page.locator(".chat-thread").last();
        await transcript.focus();
        expect(await composer.evaluate((input) => document.activeElement === input)).toBe(false);
        await page.keyboard.press(nativePasteShortcut);
        if (kind === "text") {
          await expect.poll(() => composer.inputValue()).toBe("A copied note for this session.");
          await composer.fill("");
          await transcript.focus();
          expect(await composer.evaluate((input) => document.activeElement === input)).toBe(false);
          await composer.evaluate((input) => {
            input.addEventListener(
              "paste",
              (event) => {
                input.setAttribute("data-shift-paste-trusted", String(event.isTrusted));
              },
              { once: true },
            );
          });
          if (process.platform === "darwin") {
            // Playwright's macOS bindings omit Shift+Meta+V; dispatch its native editing command.
            const cdp = await page.context().newCDPSession(page);
            const key = { key: "V", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 4 | 8 };
            try {
              await cdp.send("Input.dispatchKeyEvent", {
                type: "rawKeyDown",
                ...key,
                commands: ["PasteAndMatchStyle"],
              });
              await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
            } finally {
              await cdp.detach();
            }
          } else {
            await page.keyboard.press(`Shift+${nativePasteShortcut}`);
          }
          await expect.poll(() => composer.inputValue()).toBe("A copied note for this session.");
          expect(await composer.getAttribute("data-shift-paste-trusted")).toBe("true");
        } else {
          await page.locator(".chat-attachments-preview .chat-attachment-thumb img").waitFor();
          expect(await composer.inputValue()).toBe("");
          expect(
            await page.locator(".chat-attachments-preview .chat-attachment-thumb").count(),
          ).toBe(1);
        }
        expect(await composer.evaluate((input) => document.activeElement === input)).toBe(true);
        if (kind === "image") {
          expect(await composers.first().inputValue()).toBe("Keep the other session draft.");
          expect(
            await page
              .locator("openclaw-chat-pane")
              .first()
              .locator(".chat-attachment-thumb")
              .count(),
          ).toBe(0);
        }
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await page.screenshot({ path: `${suite.artifactDir}/native-${kind}-paste.png` });
      });
    },
  );

  it.each([
    { route: "chat", selector: ".agent-chat__composer-combobox textarea" },
    { route: "new", selector: ".new-session-page__message" },
  ])(
    "keeps a long native paste inline only in an empty $route composer",
    async ({ route, selector }) => {
      await suite.withPage(contextOptions, async ({ page }) => {
        const endMarker = "End of the attached note.";
        const pasteText =
          route === "new"
            ? `${pastedText}\n${"Keep this line reachable in the attachment reader.\n".repeat(60)}${endMarker}`
            : pastedText;
        const gateway = await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}${route}`);
        const composer = page.locator(selector);
        await composer.waitFor({ state: "visible" });
        await composer.fill("");
        await page.evaluate((text) => navigator.clipboard.writeText(text), pasteText);
        await composer.focus();
        await page.keyboard.press(nativePasteShortcut);
        await page.waitForFunction((inputSelector) => {
          const input = document.querySelector<HTMLTextAreaElement>(inputSelector);
          return Boolean(input?.value || document.querySelector("openclaw-chat-pasted-text"));
        }, selector);
        await expect.poll(() => composer.inputValue()).toBe(pasteText);
        expect(
          await page.locator(".chat-attachments-preview openclaw-chat-pasted-text").count(),
        ).toBe(0);

        await composer.fill("Keep this draft");
        await page.keyboard.press(nativePasteShortcut);
        await button(page, pastedTextLabel).waitFor();
        expect(await composer.inputValue()).toBe("Keep this draft");
        if (route === "new") {
          await button(page, pastedTextLabel).click();
          const preview = page.locator(".new-session-attachment-panel");
          const scrollport = preview.locator(".sidebar-content");
          await expect
            .poll(() => preview.locator(".sidebar-attachment-preview__text").textContent())
            .toBe(pasteText);
          await scrollport.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          await expect
            .poll(() =>
              scrollport.evaluate((element, marker) => {
                const text = element.querySelector(
                  ".sidebar-attachment-preview__text",
                )!.firstChild!;
                const range = document.createRange();
                range.setStart(text, text.textContent!.lastIndexOf(marker));
                range.setEnd(text, text.textContent!.length);
                const end = range.getBoundingClientRect();
                const port = element.getBoundingClientRect();
                const panel = element
                  .closest(".new-session-attachment-panel")!
                  .getBoundingClientRect();
                return element.scrollTop > 0 && end.top >= port.top && end.bottom <= panel.bottom;
              }, endMarker),
            )
            .toBe(true);
          await button(preview, "Close sidebar").click();
          await expect.poll(() => preview.count()).toBe(0);
        }
        await button(page, "Show in text field").click();
        await expect.poll(() => composer.inputValue()).toBe(`Keep this draft\n\n${pasteText}`);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      });
    },
  );

  it.each([1280, 390])("restores pasted text directly from the %ipx composer", async (width) => {
    const options = { ...contextOptions, viewport: { width, height: 900 } };
    await suite.withPage(options, async ({ page }) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible" });
      await composer.fill("Keep this draft");
      await paste(composer);
      const fileName = "launch-preview.html";
      const fileCard = page.locator(".chat-attachment-file__name", { hasText: fileName });
      await page.locator(".agent-chat__file-input").setInputFiles({
        name: fileName,
        mimeType: "text/html",
        buffer: Buffer.from("<!doctype html><title>Preview</title>"),
      });
      await fileCard.waitFor();
      const pastedCard = page.locator(
        ".chat-attachments-preview openclaw-chat-pasted-text .chat-attachment-thumb--file",
      );
      await button(pastedCard, pastedTextLabel).waitFor();
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
            const { left, right, top, bottom } = action.getBoundingClientRect();
            const { border, borderRadius } = getComputedStyle(card);
            const otherStyle = getComputedStyle(other);
            return {
              sameBorder: border === otherStyle.border && borderRadius === otherStyle.borderRadius,
              secondRow: top >= name.getBoundingClientRect().bottom,
              inside: left >= rect.left && right <= rect.right && bottom < rect.bottom,
              readable: action.clientWidth >= action.scrollWidth,
              nestedControls: card.querySelectorAll("button button, button a, [role=button] button")
                .length,
            };
          }),
        ).toEqual({
          sameBorder: true,
          secondRow: true,
          inside: true,
          readable: true,
          nestedControls: 0,
        });
      }
      const restore = button(pastedCard, "Show in text field");
      await restore.focus();
      // A background session refresh must not replace the focused restore control.
      const sessionRow = await gateway.getSessionRow("agent:main:main");
      await gateway.emitGatewayEvent("sessions.changed", {
        ...sessionRow,
        key: "agent:main:main",
        sessionKey: "agent:main:main",
        reason: "patch",
        label: "Refreshed paste session",
        updatedAt: Date.now(),
      });
      await page
        .locator("openclaw-chat-pane.chat-pane-cache__pane--active")
        .getByText("Refreshed paste session", { exact: true })
        .filter({ visible: true })
        .first()
        .waitFor();
      expect(await restore.evaluate((node) => document.activeElement === node)).toBe(true);
      await page.keyboard.press("Enter");
      await expect.poll(() => composer.inputValue()).toBe(`Keep this draft\n\n${pastedText}`);
      expect(
        await page.locator(".chat-attachments-preview openclaw-chat-pasted-text").count(),
      ).toBe(0);
      expect(await fileCard.count()).toBe(1);
      expect(await page.locator("openclaw-chat-detail-panel:visible").count()).toBe(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });

  it("opens, copies, and restores exact pasted text under the Gateway CSP", async () => {
    await suite.withPage(contextOptions, async ({ page }) => {
      const chatUrl = `${suite.server.baseUrl}chat`;
      let gatewayCsp = "";
      await page.route(chatUrl, async (route) => {
        const response = await route.fetch();
        const body = await response.text();
        gatewayCsp = buildControlUiCspHeader({
          inlineScriptHashes: computeInlineScriptHashes(body),
        });
        await route.fulfill({
          response,
          body,
          headers: { ...response.headers(), "content-security-policy": gatewayCsp },
        });
      });
      const gateway = await installMockGateway(page);
      const response = await page.goto(chatUrl);
      expect(gatewayCsp).not.toBe("");
      expect(response?.headers()["content-security-policy"]).toBe(gatewayCsp);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible" });
      await composer.fill("Review the attachment");
      await paste(composer);
      await composer.fill("");
      const chip = button(page, pastedTextLabel);
      await chip.focus();
      await page.keyboard.press("Enter");
      const preview = page.locator("openclaw-chat-detail-panel:visible");
      await preview.waitFor({ state: "visible" });
      expect(await chip.evaluate((element) => element.closest("openclaw-tooltip") === null)).toBe(
        true,
      );
      const content = preview.locator(".sidebar-attachment-preview__text");
      await expect.poll(() => content.textContent()).toBe(pastedText);
      expect(await content.evaluate((element) => getComputedStyle(element).fontFamily)).toMatch(
        /mono/i,
      );
      await button(preview, "Copy").click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(pastedText);
      await button(preview, "Show in text field").click();
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
      await composer.fill("Review the attachment");
      await paste(composer);
      await composer.fill("");
      const scopeKey = `chat:v3:${sessionKey}\u0000agent:main`;
      await waitForCommittedComposerDraft(page, scopeKey, "", 1);
      const fileName = await page.evaluate(
        async ({ scopeKey: storedScopeKey, legacy: restoreLegacy }) => {
          const once = (target: EventTarget, event: string, run: () => void) =>
            target.addEventListener(event, run, { once: true });
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("openclaw-control-ui");
            once(request, "success", () => resolve(request.result));
            once(request, "error", () =>
              reject(request.error ?? new Error("Could not open composer draft database")),
            );
          });
          try {
            return await new Promise<string>((resolve, reject) => {
              const transaction = database.transaction(
                "composerDrafts",
                restoreLegacy ? "readwrite" : "readonly",
              );
              const store = transaction.objectStore("composerDrafts");
              const request: IDBRequest<
                Array<{
                  scopeKey: string;
                  attachments: Array<{ fileName: string; origin?: string }>;
                }>
              > = store.getAll();
              let savedFileName: string | undefined;
              once(request, "success", () => {
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
              });
              once(transaction, "complete", () =>
                savedFileName
                  ? resolve(savedFileName)
                  : reject(new Error("Missing persisted attachment")),
              );
              for (const event of ["abort", "error"]) {
                once(transaction, event, () =>
                  reject(transaction.error ?? new Error("Draft fixture transaction failed")),
                );
              }
            });
          } finally {
            database.close();
          }
        },
        { scopeKey, legacy },
      );
      await page.reload();
      const chip = button(page, pastedTextLabel);
      await chip.click();
      const preview = page.locator("openclaw-chat-detail-panel:visible");
      await expectPastedText(preview);
      await composer.click();
      await button(page, "Send message").click();
      await expect.poll(async () => (await gateway.getRequests("chat.send")).length).toBe(1);
      const params = (await gateway.getRequests("chat.send"))[0]!.params;
      expect(params).toHaveProperty("attachments", [
        {
          type: "file",
          mimeType: "text/plain",
          fileName,
          ...(!legacy ? { origin: "paste" } : {}),
          content: Buffer.from(pastedText).toString("base64"),
        },
      ]);
      expect(fileName).toMatch(/^pasted-text-\d+\.txt$/);
    });
  });

  it("projects persisted origins and legacy names into ordered chips and ordinary file cards", async () => {
    await suite.withPage(contextOptions, async ({ page }) => {
      const comment =
        "Selected text:\nReview this\n\nUser comment:\nKeep spacing.\n\nSource session: agent:main:main\nSelected text UTF-16 length: 11\nDOM text UTF-16 range: [0, 11)";
      const retryUrl = `${suite.server.baseUrl}pasted-note-retry.txt`;
      let sourceAvailable = false;
      await page.route(retryUrl, (route) =>
        route.fulfill({
          status: sourceAvailable ? 200 : 503,
          contentType: "text/plain; charset=utf-8",
          body: sourceAvailable ? pastedText : "Temporarily unavailable",
        }),
      );
      await installMockGateway(page, {
        historyMessages: [
          history(
            [
              fact(comment, "selection-comment.txt", "file"),
              fact(pastedText, "renamed-note.md", "paste", { url: retryUrl }),
              fact("Legacy pasted text", "pasted-text-123.txt"),
            ],
            "Please review the attached notes.",
          ),
          {
            role: "assistant",
            content: [{ type: "text", text: "Next attachments" }],
            timestamp: 2,
          },
          history(
            [
              fact("Chosen file", "pasted-text-123.txt", "file"),
              fact("Ordinary historical text", "pasted-text-other.txt"),
            ],
            "",
            3,
          ),
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
        .poll(() => shell.evaluate(historyLayout, false))
        .toEqual({ above: true, horizontal: true, aligned: true, paintedText: true });
      await page.setViewportSize({ width: 390, height: 900 });
      await expect
        .poll(() => shell.evaluate(historyLayout, true))
        .toEqual({
          above: true,
          wrapped: true,
          sharesRow: true,
          withinViewport: true,
          aligned: true,
        });
      await chips.nth(1).click();
      const preview = page.locator("openclaw-chat-detail-panel:visible");
      const retry = button(preview, "Retry");
      await retry.waitFor();
      const download = preview.getByRole("link", { name: "Download renamed-note.md", exact: true });
      expect(await download.getAttribute("href")).toBe(retryUrl);
      expect(await download.getAttribute("download")).toBe("renamed-note.md");
      sourceAvailable = true;
      await retry.click();
      await expectPastedText(preview);
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
        historyMessages: [history([fact(text, fileName, "paste", { sizeBytes: bytes.length })])],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await button(page, "Preserve the original UTF-8 te…").click();
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
      expect(await readControlUiE2eDownload(download)).toEqual(bytes);
    });
  });
});
