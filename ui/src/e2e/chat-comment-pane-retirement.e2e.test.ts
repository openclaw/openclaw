import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sessionsListResponse } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Comment pane retirement" });
const passage = "Alpha deployment checklist needs review.";
const unsaved = "Keep this unsaved comment in Alpha.";

suite.define(() => {
  it.each([
    { editorKind: "new", archivedPane: "other" },
    { editorKind: "reopened", archivedPane: "other" },
    { editorKind: "reply-menu", archivedPane: "other" },
    { editorKind: "reply-menu", archivedPane: "own" },
    { editorKind: "new", archivedPane: "own" },
    { editorKind: "reopened", archivedPane: "own" },
  ] as const)(
    "preserves comment ownership for $editorKind editor when $archivedPane pane archives",
    async ({ editorKind, archivedPane }) => {
      await suite.withPage(
        { viewport: { width: 1920, height: 1000 }, locale: "en-US", reducedMotion: "reduce" },
        async ({ page }) => {
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          const alpha = createControlUiSessionRow("agent:main:comment-alpha", "Alpha", 1);
          const beta = createControlUiSessionRow("agent:main:comment-beta", "Beta", 2);
          const rows = [alpha, beta];
          // Persisted split layout is the public setup boundary used by sibling split tests.
          await page.addInitScript(
            ({ storageKey, sessions }) => {
              localStorage.setItem(
                storageKey,
                JSON.stringify({
                  chatSplitLayout: {
                    activePaneId: "p1",
                    columnWeights: [0.5, 0.5],
                    columns: sessions.map((row, index) => ({
                      id: `c${index + 1}`,
                      paneWeights: [1],
                      panes: [{ id: `p${index + 1}`, sessionKey: row.key }],
                    })),
                  },
                }),
              );
            },
            {
              storageKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
              sessions: rows,
            },
          );
          const gateway = await installMockGateway(page, {
            sessionKey: alpha.key,
            sessions: rows,
            sessionArchiveFiltering: true,
            sessionTranscripts: {
              [alpha.key]: { messages: [{ role: "assistant", content: passage, timestamp: 1 }] },
              [beta.key]: {
                messages: [
                  { role: "assistant", content: "Beta review is complete.", timestamp: 1 },
                ],
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}chat/main/comment-alpha`);
          const panes = page.locator('openclaw-chat-page openclaw-chat-pane[aria-hidden="false"]');
          await expect.poll(() => panes.count()).toBe(2);
          const paneA = panes.filter({ hasText: passage });
          const paneB = panes.filter({ hasText: "Beta review is complete." });
          await paneA
            .locator(".agent-chat__composer-combobox textarea")
            .fill("Preserve Alpha draft.");
          await paneB.getByText("Beta review is complete.", { exact: true }).waitFor();
          const source = paneA.locator(".chat-bubble .chat-text p").filter({ hasText: passage });
          const editor = page.getByRole("dialog", { name: "Comment", exact: true });
          const menu = page.locator(".chat-reply-context-menu");
          if (editorKind === "reply-menu") {
            await source.click({ button: "right" });
            await menu.waitFor({ state: "visible" });
            expect(await menu.evaluate((element) => element.contains(document.activeElement))).toBe(
              true,
            );
          } else {
            await source.evaluate((element) => {
              const range = document.createRange();
              range.selectNodeContents(element);
              const selection = window.getSelection();
              selection?.removeAllRanges();
              selection?.addRange(range);
            });
            await source.dispatchEvent("pointerup", { button: 0, pointerType: "mouse" });
            await page
              .getByRole("toolbar", { name: "Selection actions" })
              .getByRole("button", { name: "Add to chat", exact: true })
              .click();
            if (editorKind === "reopened") {
              await editor.getByRole("textbox").fill("Saved Alpha comment.");
              await editor.getByRole("textbox").press("Enter");
              await paneA.locator(".chat-comment-pin").click();
              await expect
                .poll(() => editor.getByRole("textbox").inputValue())
                .toBe("Saved Alpha comment.");
            }
            await editor.getByRole("textbox").fill(unsaved);
            expect(
              await editor
                .getByRole("textbox")
                .evaluate((element) => element === document.activeElement),
            ).toBe(true);
          }
          await page.screenshot({ path: path.join(suite.artifactDir, "before-archive.png") });
          const target = archivedPane === "own" ? alpha : beta;
          const archived = { ...target, archived: true, archivedAt: 3, updatedAt: 3 };
          await gateway.setSessionsListResponse(
            sessionsListResponse(rows.map((row) => (row.key === target.key ? archived : row))),
          );
          // A second client's committed archive arrives through the actual Gateway event path.
          await gateway.emitGatewayEvent("sessions.changed", {
            ...archived,
            agentId: "main",
            sessionKey: target.key,
            reason: "patch",
          });
          const targetPane = archivedPane === "own" ? paneA : paneB;
          await targetPane.locator(".agent-chat__disabled-banner").waitFor({ state: "visible" });
          const observations = await page.evaluate(() => {
            const input = document.querySelector<HTMLTextAreaElement>(
              ".chat-annotation-editor textarea",
            );
            const focus = document.activeElement;
            return {
              editorPresent: Boolean(input),
              editorText: input?.value ?? null,
              editorFocused: Boolean(input && focus === input),
              focusTag: focus?.tagName,
              focusClass: focus?.className,
              focusedPane: focus
                ?.closest("openclaw-chat-pane")
                ?.getAttribute("data-mcp-app-owner-key"),
              presentedPanes: Array.from(
                document.querySelectorAll(
                  'openclaw-chat-page openclaw-chat-pane[aria-hidden="false"]',
                ),
              ).map((pane) => ({
                owner: pane.getAttribute("data-mcp-app-owner-key"),
                archived: Boolean(pane.querySelector(".agent-chat__disabled-banner")),
              })),
            };
          });
          await writeFile(
            path.join(suite.artifactDir, "observations.json"),
            JSON.stringify({ editorKind, archivedPane, ...observations, errors }, null, 2),
          );
          await page.screenshot({ path: path.join(suite.artifactDir, "after-archive.png") });
          expect(errors).toEqual([]);
          if (archivedPane === "own") {
            expect(observations.editorPresent).toBe(false);
            expect(await menu.count()).toBe(0);
            expect(
              await paneA
                .locator(".chat-thread")
                .evaluate((element) => element === document.activeElement),
            ).toBe(true);
          } else if (editorKind === "reply-menu") {
            expect(await menu.count()).toBe(1);
            expect(await menu.evaluate((element) => element.contains(document.activeElement))).toBe(
              true,
            );
            await page.keyboard.press("Escape");
            expect(await menu.count()).toBe(0);
            expect(
              await paneA
                .locator(".agent-chat__composer-combobox textarea")
                .evaluate((element) => element === document.activeElement),
            ).toBe(true);
          } else {
            expect.soft(observations.editorPresent).toBe(true);
            expect.soft(observations.editorText).toBe(unsaved);
            expect.soft(observations.editorFocused).toBe(true);
            if (observations.editorPresent) {
              await page.keyboard.type(" Continue reviewing.");
              expect(await editor.getByRole("textbox").inputValue()).toBe(
                `${unsaved} Continue reviewing.`,
              );
              await editor.getByRole("textbox").press("Enter");
              expect(
                await paneA.locator(".chat-selection-annotations__chip").textContent(),
              ).toContain("1 comment");
              await paneA.locator(".chat-comment-pin").click();
              await expect
                .poll(() => editor.getByRole("textbox").inputValue())
                .toBe(`${unsaved} Continue reviewing.`);
            }
          }
          if (archivedPane === "other") {
            expect(
              await paneA.locator(".agent-chat__composer-combobox textarea").inputValue(),
            ).toBe("Preserve Alpha draft.");
          }
          expect(await gateway.getRequests("chat.send")).toEqual([]);
          expect(await gateway.getRequests("sessions.patch")).toEqual([]);
        },
      );
    },
  );
});
