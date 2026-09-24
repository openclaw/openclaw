import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each([
    {
      name: "visible final answer",
      sourceId: "inventory-final_answer",
      sourceText: "The lunar exhibit inventory is complete.",
      deepWork: false,
    },
    {
      name: "folded earlier assistant message",
      sourceId: "inventory-earlier",
      sourceText: "I am checking the lunar exhibit inventory.",
      deepWork: false,
    },
    {
      name: "deep earlier message in standalone work",
      sourceId: "inventory-earlier",
      sourceText: "I am checking the lunar exhibit inventory.",
      deepWork: true,
    },
  ])(
    "reveals the $name after replying through transcript search",
    async ({ name, sourceId, sourceText, deepWork }) => {
      const artifactDir = createControlUiE2eArtifactDir(`chat-reply-reveal-${sourceId}`);
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const sessionKey = `agent:main:dashboard:reply-reveal-${sourceId}`;
        const settledRunId = "museum-inventory-run";
        const earlierWork = deepWork
          ? Array.from({ length: 32 }, (_, index) => ({
              role: index % 2 === 0 ? "assistant" : "toolResult",
              ...(index % 2 === 0
                ? {}
                : { toolName: "read", toolCallId: `inventory-read-${index}` }),
              content: `Inspecting museum room ${index + 1}.`,
              timestamp: 1_800_000_000_001 + index,
              __openclaw: { id: `inventory-work-${index}`, seq: index + 2 },
            }))
          : [];
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const gateway = await installMockGateway(page, {
          sessionKey,
          historyMessages: [
            {
              role: "user",
              content: "Prepare the museum inventory.",
              timestamp: 1_800_000_000_000,
              __openclaw: {
                id: "inventory-prompt",
                seq: 1,
                ...(!deepWork ? { idempotencyKey: `${settledRunId}:user` } : {}),
              },
            },
            ...earlierWork,
            {
              role: "assistant",
              ...(!deepWork ? { runId: settledRunId } : {}),
              content: "I am checking the lunar exhibit inventory.",
              timestamp: 1_800_000_000_001 + earlierWork.length,
              __openclaw: { id: "inventory-earlier", seq: 2 + earlierWork.length },
            },
            {
              role: "assistant",
              phase: "final_answer",
              stopReason: "stop",
              ...(!deepWork ? { runId: settledRunId } : {}),
              content: "The lunar exhibit inventory is complete.",
              timestamp: 1_800_000_000_002 + earlierWork.length,
              __openclaw: { id: "inventory-final_answer", seq: 3 + earlierWork.length },
            },
          ],
        });
        const pane = page.locator(".chat-pane-cache__pane--active");
        const source = pane.locator(`.chat-bubble[data-entry-id="${sourceId}"]`);
        const earlierMessage = pane.locator('.chat-bubble[data-entry-id="inventory-earlier"]');
        const workToggle = pane.locator(".chat-work-group button");
        try {
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await expect.poll(() => workToggle.getAttribute("aria-expanded")).toBe("false");
          expect(await earlierMessage.count()).toBe(0);

          const composer = pane.locator(".agent-chat__composer-combobox textarea");
          await composer.focus();
          const shortcut = await page.evaluate(() =>
            /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta+f" : "Control+f",
          );
          await page.keyboard.press(shortcut);
          const search = pane.getByRole("textbox", { name: "Search messages", exact: true });
          await search.fill(sourceText);
          await expect
            .poll(() => pane.locator('.chat-bubble[data-entry-id="inventory-prompt"]').count())
            .toBe(0);
          await source.waitFor({ state: "visible" });
          await source.click({ button: "right" });
          await page
            .locator(".chat-reply-context-menu")
            .getByRole("menuitem", { name: "Reply to message", exact: true })
            .click();
          await expect
            .poll(() => pane.locator(".chat-reply-preview__text").textContent())
            .toBe(sourceText);

          const followup = "Please explain that step in more detail.";
          await composer.fill(followup);
          await pane.getByRole("button", { name: "Send message", exact: true }).click();
          const send = await gateway.waitForRequest("chat.send");
          const params = requireRecord(send.params);
          expect(params).toMatchObject({ sessionKey, message: followup, replyToId: sourceId });
          await expect.poll(() => composer.inputValue()).toBe("");
          await pane
            .getByRole("button", { name: "Stop generating", exact: true })
            .waitFor({ state: "visible" });
          await gateway.emitChatFinal({
            sessionKey,
            runId: requireString(params.idempotencyKey, "reply run ID"),
            text: "Here is more detail about the inventory step.",
          });
          await pane.getByRole("button", { name: "Close search", exact: true }).click();
          await expect.poll(() => workToggle.getAttribute("aria-expanded")).toBe("false");
          expect(await earlierMessage.count()).toBe(0);
          const preview = pane.locator(".chat-reply-preview--message");
          await expect.poll(() => preview.textContent()).toContain(sourceText);
          await page.screenshot({ path: path.join(artifactDir, "before-reveal.png") });

          await preview.click();
          await expect
            .poll(() =>
              pane.locator(`[data-entry-id="${sourceId}"].chat-bubble--reply-target`).count(),
            )
            .toBe(1);
          expect(await source.isVisible()).toBe(true);
          await expect
            .poll(() =>
              source.evaluate((element) => {
                const thread = element.closest(".chat-thread");
                if (!thread) {
                  throw new Error("Reply target is outside the transcript");
                }
                const target = element.getBoundingClientRect();
                const viewport = thread.getBoundingClientRect();
                return (
                  Math.min(target.bottom, viewport.bottom) > Math.max(target.top, viewport.top) &&
                  Math.min(target.right, viewport.right) > Math.max(target.left, viewport.left)
                );
              }),
            )
            .toBe(true);
          expect(await source.textContent()).toContain(sourceText);
          if (deepWork) {
            const scroll = await source.evaluate((element) => {
              const thread = element.closest(".chat-thread");
              if (!thread) {
                throw new Error("Reply target is outside the transcript");
              }
              return { top: thread.scrollTop, height: thread.clientHeight };
            });
            expect(scroll.top).toBeGreaterThan(scroll.height);
          }
          expect(await gateway.getRequests("chat.send")).toHaveLength(1);
          expect(pageErrors).toEqual([]);
        } finally {
          await page.screenshot({ path: path.join(artifactDir, "after-reveal.png") });
          await writeFile(
            path.join(artifactDir, "result.json"),
            JSON.stringify(
              {
                name,
                sourceId,
                sourceVisible: await source.isVisible(),
                sourceText: await source.allTextContents(),
                sends: await gateway.getRequests("chat.send"),
                pageErrors,
              },
              null,
              2,
            ),
          );
        }
      });
    },
  );
});
