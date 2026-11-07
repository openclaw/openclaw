import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

suite.define(() => {
  it("finds recovered reply text and keeps it when transcript search is cleared", async () => {
    const artifactDir = createControlUiE2eArtifactDir("chat-recovered-search");
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const sessionKey = "agent:main:recovered-search";
      const messageId = "recovered-search-answer";
      const keyword = "lunarneedle";
      const fullText = `# Museum inventory\n\nThe restored exhibit is ${keyword}.`;
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessions: [
          createControlUiSessionRow(sessionKey, "Recovered search", 1_800_000_000_000, {
            sessionId: "recovered-search-session",
            lifecycleRevision: "recovered-search-revision-1",
          }),
        ],
        deferredMethods: ["chat.message.get"],
        historyMessages: [
          {
            role: "user",
            content: "Prepare the museum inventory.",
            timestamp: 1_800_000_000_000,
            __openclaw: { id: "recovered-search-prompt", seq: 1 },
          },
          {
            role: "assistant",
            content: "Museum inventory preview\n...(truncated)...",
            timestamp: 1_800_000_000_001,
            __openclaw: { id: messageId, seq: 2, truncated: true },
          },
        ],
      });
      // Search recovery uses the settled roster's message scope, independent of boot ordering.
      await page.goto(`${suite.server.baseUrl}activity`);
      await page
        .locator(
          `.sidebar-recent-session[data-session-key="${sessionKey}"] a.sidebar-recent-session__link`,
        )
        .click();
      const pane = page.locator(".chat-pane-cache__pane--active");
      const reply = pane.locator(`.chat-bubble[data-entry-id="${messageId}"]`);
      const prompt = pane.locator('.chat-bubble[data-entry-id="recovered-search-prompt"]');
      await prompt.waitFor({ state: "visible" });
      const request = await gateway.waitForRequest("chat.message.get");
      expect(request.params).toMatchObject({ sessionKey, messageId });
      await expect.poll(() => reply.textContent()).toContain("Museum inventory preview");
      await gateway.resolveDeferred("chat.message.get", {
        ok: true,
        message: { role: "assistant", content: fullText },
      });
      await expect.poll(() => reply.textContent()).toContain(keyword);
      if (captureUiProofEnabled) {
        await page.screenshot({ path: path.join(artifactDir, "recovered.png") });
      }

      const composer = pane.locator(".agent-chat__composer-combobox textarea");
      await composer.focus();
      const shortcut = await page.evaluate(() =>
        /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta+f" : "Control+f",
      );
      await page.keyboard.press(shortcut);
      const search = pane.getByRole("textbox", { name: "Search messages", exact: true });
      await search.fill(keyword);
      // The unrelated prompt leaving the DOM proves the filter has committed.
      await expect.poll(() => prompt.count()).toBe(0);
      const filteredReplyTexts = await reply.allTextContents();
      if (captureUiProofEnabled) {
        await page.screenshot({ path: path.join(artifactDir, "search.png") });
      }

      await pane.getByRole("button", { name: "Close search", exact: true }).click();
      await expect.poll(() => reply.textContent()).toContain(keyword);
      expect(await search.count()).toBe(0);
      expect(await composer.evaluate((element) => document.activeElement === element)).toBe(true);
      expect(await gateway.getRequests("chat.message.get")).toHaveLength(1);
      if (captureUiProofEnabled) {
        await page.screenshot({ path: path.join(artifactDir, "cleared.png") });
      }
      await writeFile(
        path.join(artifactDir, "result.json"),
        JSON.stringify(
          { keyword, filteredReplyTexts, restoredText: await reply.textContent() },
          null,
          2,
        ),
      );

      expect(filteredReplyTexts.join("\n")).toContain(keyword);
    });
  });

  it("matches rendered text across inline formatting and marks each occurrence", async () => {
    const artifactDir = createControlUiE2eArtifactDir("chat-search-highlight");
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const sessionKey = "agent:main:search-highlight";
      await page.route("**/__openclaw__/link-favicon/example.com", (route) =>
        route.fulfill({
          body: Buffer.from(PIXEL_PNG.split(",")[1]!, "base64"),
          contentType: "image/png",
          status: 200,
        }),
      );
      await installMockGateway(page, {
        sessionKey,
        sessions: [
          createControlUiSessionRow(sessionKey, "Search highlights", 1_800_000_000_000, {
            sessionId: "search-highlight-session",
            lifecycleRevision: "search-highlight-revision-1",
          }),
        ],
        automaticallyFetchFavicons: true,
        historyMessages: [
          {
            role: "user",
            content: "**Draft** the pull request for @**Ada** Lovelace.",
            timestamp: 1_800_000_000_000,
            __openclaw: {
              id: "search-highlight-prompt",
              seq: 1,
              humanMentions: [{ profileId: "profile-ada", start: 31, end: 48 }],
            },
          },
          {
            role: "assistant",
            content: [
              "Titel: `fix(review): keep proof`",
              "The **review** waits for proof, see [review notes](https://example.com/notes).",
              "Run this:",
              "```ts\nconst proof = 1;\n```",
              "Raw <b>html</b> stays literal.<br>Next line",
              `Chart ![chart](${PIXEL_PNG}) below, then chart below.`,
              "Open `/tmp/src/foo.ts` now.",
              "**Use** #fff now.",
              "**Cafe**\u0301 now",
            ].join("\n\n"),
            timestamp: 1_800_000_000_001,
            __openclaw: { id: "search-highlight-answer", seq: 2 },
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}activity`);
      await page
        .locator(
          `.sidebar-recent-session[data-session-key="${sessionKey}"] a.sidebar-recent-session__link`,
        )
        .click();
      const pane = page.locator(".chat-pane-cache__pane--active");
      const prompt = pane.locator('.chat-bubble[data-entry-id="search-highlight-prompt"]');
      const reply = pane.locator('.chat-bubble[data-entry-id="search-highlight-answer"]');
      await reply.waitFor({ state: "visible" });
      const marked = () =>
        page.evaluate(() =>
          Array.from(CSS.highlights.get("openclaw-chat-search") ?? [], (range) => ({
            text: range instanceof Range ? range.toString() : "",
            code: Boolean(range.startContainer.parentElement?.closest(".chat-text code")),
          })),
        );

      await pane.locator(".agent-chat__composer-combobox textarea").focus();
      const shortcut = await page.evaluate(() =>
        /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta+f" : "Control+f",
      );
      await page.keyboard.press(shortcut);
      const search = pane.getByRole("textbox", { name: "Search messages", exact: true });
      await search.fill("Titel: fix(review)");
      await expect.poll(() => prompt.count()).toBe(0);
      await expect.poll(marked).toEqual([
        { text: "Titel: ", code: false },
        { text: "fix(review)", code: true },
      ]);
      if (captureUiProofEnabled) {
        await page.screenshot({ path: path.join(artifactDir, "formatted-query.png") });
      }

      // The code-block language label sits between the paragraph and the code.
      await search.fill("this: const proof");
      await expect
        .poll(async () => {
          const ranges = await marked();
          return {
            text: ranges
              .map(({ text }) => text)
              .join(" ")
              .replace(/\s+/gu, " "),
            startsInCode: ranges[0]?.code,
            endsInCode: ranges.at(-1)?.code,
          };
        })
        .toEqual({ text: "this: const proof", startsInCode: false, endsInCode: true });
      await search.fill("raw html stays");
      await expect.poll(() => reply.count()).toBe(0);
      await search.fill("<b>html</b> stays");
      await expect.poll(marked).toEqual([{ text: "<b>html</b> stays", code: false }]);
      await search.fill("literal. next line");
      await expect.poll(marked).toEqual([
        { text: "literal.", code: false },
        { text: "Next line", code: false },
      ]);

      // An inline image separates the words around it; a link favicon does not.
      await expect.poll(() => reply.locator("img.markdown-inline-image").count()).toBe(1);
      await search.fill("chart below");
      await expect.poll(marked).toEqual([{ text: "chart below", code: false }]);
      await expect.poll(() => reply.locator("img.markdown-link-favicon").count()).toBe(1);
      await search.fill("see review notes");
      await expect.poll(marked).toEqual([
        { text: "see ", code: false },
        { text: "review notes", code: false },
      ]);

      // File links render a shortened label; search follows the label on screen.
      await search.fill("open foo.ts now");
      await expect
        .poll(async () => (await marked()).map(({ text }) => text).join(""))
        .toBe("Open foo.ts now");

      await search.fill("Use #fff now");
      await expect
        .poll(async () => (await marked()).map(({ text }) => text).join(""))
        .toBe("Use #fff now");
      for (const query of ["CAFÉ now", "CAFE\u0301 now"]) {
        await search.fill(query);
        await expect.poll(marked).toEqual([
          { text: "Cafe", code: false },
          { text: "\u0301 now", code: false },
        ]);
      }
      await search.fill("Use now");
      await expect.poll(() => reply.count()).toBe(0);

      // The copied @ has zero font size; visible-text search follows the shown name.
      await search.fill("for **Ada** Lovelace");
      await expect
        .poll(async () => (await marked()).map(({ text }) => text).join(""))
        .toBe("for **Ada** Lovelace");
      await search.fill("for @**Ada** Lovelace");
      await expect.poll(() => prompt.count()).toBe(1);
      await expect.poll(marked).toEqual([]);
      // A mention renders its visible name inside a button; it is message text.
      await search.fill("**Ada** Lovelace");
      await expect.poll(() => reply.count()).toBe(0);
      await expect.poll(marked).toEqual([{ text: "**Ada** Lovelace", code: false }]);

      await search.fill("REVIEW");
      await expect
        .poll(async () => (await marked()).map(({ text }) => text))
        .toEqual(["review", "review", "review"]);
      expect(await reply.locator("mark").count()).toBe(0);
      if (captureUiProofEnabled) {
        await page.screenshot({ path: path.join(artifactDir, "all-occurrences.png") });
      }

      await pane.getByRole("button", { name: "Close search", exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => CSS.highlights.has("openclaw-chat-search")))
        .toBe(false);
      await expect.poll(() => prompt.count()).toBe(1);
    });
  });
});
