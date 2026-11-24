import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const messageBody = ".chat-session-activity__message";
const runSelector = "a[data-cron-run-link]";
const disclosure = ".chat-message-disclosure__toggle";
const turn = (role: string, content: string, timestamp: number) => ({ role, content, timestamp });
function delivery(
  sessionKey: string,
  content: string,
  seq: number,
  provenance: {
    kind: string;
    sourceTool: string;
    sourceSummary?: string;
    jobId?: string;
    runId?: string;
  },
  label?: string,
) {
  return {
    ...turn("assistant", content, 1000 + seq),
    provenance: { ...provenance, sourceSessionKey: sessionKey },
    senderSession: { sessionKey, agentId: "main", ...(label ? { label } : {}) },
    __openclaw: {
      id: "delivery-" + seq,
      seq,
      ...(provenance.kind === "inter_session" ? { runId: "run-" + seq } : {}),
      turnBoundary: true,
    },
  };
}
const cron = (jobId: string, runId: string) => ({
  kind: "internal_system",
  sourceTool: "cron",
  jobId,
  runId,
});
const row = (key: string, displayName: string) => ({
  key,
  displayName,
  kind: "direct",
  updatedAt: 1,
});
async function openActivity(
  page: Page,
  sessionKey: string,
  sessions: ReturnType<typeof row>[],
  historyMessages: unknown[],
) {
  await installMockGateway(page, { sessionKey, sessions, historyMessages });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
  const activity = page.locator(".chat-session-activity");
  return { activity, summary: activity.locator("summary"), thread: page.locator(".chat-thread") };
}
async function openRun(page: Page, job: string, run: string) {
  await page.waitForURL(
    (url) =>
      url.pathname.endsWith("/automations") &&
      url.searchParams.get("job") === job &&
      url.searchParams.get("run") === run,
  );
}

suite.define(() => {
  it.each([true, false])(
    "keeps automation disclosure and run navigation stable (labeled=%s)",
    async (labeled) => {
      const key = "agent:main:dashboard:automation";
      const artifacts = createControlUiE2eArtifactDir(
        labeled ? "automation-activity" : "automation-activity-summary",
      );
      const answerText = "The checks are passing. The pull request is ready to merge.";
      const [job, run] = labeled ? ["job-0", "run-0"] : ["morning-briefing", "run-7"];
      const labels = labeled
        ? ["Auto-fix CI and address comments", "Auto-merge when ready"]
        : [undefined];
      await suite.withPage(
        {
          viewport: labeled ? { width: 1440, height: 1000 } : { width: 1280, height: 800 },
          ...(labeled ? {} : { colorScheme: "dark" as const }),
          locale: "en-US",
          serviceWorkers: "block",
        },
        async ({ page }) => {
          const { activity, thread } = await openActivity(
            page,
            key,
            [row(key, "Review pull request")],
            [
              turn("user", "Check this pull request and land it when it is ready.", 1000),
              ...labels.map((label, i) =>
                delivery(
                  key,
                  labeled
                    ? "Verify the current pull request and preserve review gates. ".repeat(30) +
                        "End of automation prompt."
                    : "Summarize overnight pull request activity and failing checks in three bullets.",
                  i + 2,
                  cron(labeled ? "job-" + i : job, labeled ? "run-" + i : run),
                  label,
                ),
              ),
              {
                ...turn("assistant", answerText, labeled ? 4000 : 3000),
                phase: "final_answer",
                __openclaw: { id: "answer", seq: labels.length + 2, runId: "answer-run" },
              },
            ],
          );
          const answer = page.getByText(answerText, { exact: true });
          await answer.waitFor();
          const first = activity.first();
          const summary = first.locator("summary");
          const link = summary.locator(runSelector);
          const body = first.locator(messageBody);
          const capture = async (state: "collapsed" | "expanded") => {
            const frame = await takeControlUiScreenshotFrame(
              page,
              thread,
              labeled ? [answer] : [summary, answer],
              { animations: "disabled", elements: labeled ? [thread] : [thread, summary] },
            );
            const names = labeled ? ["desktop"] : [state, state + "-summary"];
            for (const [index, name] of names.entries()) {
              await writeFile(path.join(artifacts, name + ".png"), frame.elements[index]!.png);
            }
            return summary.evaluate((element) => {
              const source = element.querySelector("a[data-cron-run-link]");
              return {
                markup: element.innerHTML.replace(/<!--[^]*?-->/gu, ""),
                text: element.textContent?.replace(/\s+/gu, " ").trim(),
                width: element.querySelector(".chat-reply-attribution")?.getBoundingClientRect()
                  .width,
                sourceColor: source ? getComputedStyle(source).color : null,
              };
            });
          };
          expect([
            await activity.count(),
            await page.locator(".chat-group--forwarded").count(),
            await body.count(),
          ]).toEqual([labels.length, 0, 0]);
          expect(await link.getAttribute("href")).toBe(`/automations?job=${job}&run=${run}`);
          const collapsed = await capture("collapsed");
          if (labeled) {
            expect(await summary.textContent()).toContain(labels[0]);
            await summary.focus();
            await summary.press("Enter");
          } else {
            await summary.getByText("1 update from", { exact: true }).click();
          }
          await first
            .getByText(labeled ? /End of automation prompt.$/ : /in three bullets\.$/u)
            .waitFor();
          if (labeled) {
            expect(await first.locator(runSelector).getAttribute("href")).toBe(
              `/automations?job=${job}&run=${run}`,
            );
            expect(await first.locator(disclosure).count()).toBe(0);
          } else {
            expect(await capture("expanded")).toEqual(collapsed);
            expect(collapsed.text).toBe("1 update from Automation");
            expect(await link.locator(".session-link-icon svg").count()).toBe(1);
          }
          await summary.focus();
          await summary.press(labeled ? "Space" : "Enter");
          await body.waitFor({ state: "detached" });
          if (labeled) {
            const mobile = await takeControlUiScreenshotFrame(page, thread, [summary, answer], {
              animations: "disabled",
              viewport: { width: 390, height: 844 },
            });
            await writeFile(path.join(artifacts, "mobile.png"), mobile.png);
          }
          const toggles = await first.evaluateHandle((details) => {
            const observed = { count: 0 };
            new MutationObserver((records) => {
              observed.count += records.length;
            }).observe(details, { attributeFilter: ["open"] });
            return observed;
          });
          await link.click();
          await openRun(page, job, run);
          expect(await toggles.evaluate((observed) => observed.count)).toBe(0);
        },
      );
    },
  );

  it.each([1440, 390])(
    "keeps incoming source messages left-aligned and navigable at %ipx",
    async (width) => {
      const key = "agent:main:activity-reader";
      const sourceKey = "agent:main:activity-source";
      const label = "Verification session";
      await suite.withPage(
        {
          viewport: { width, height: 844 },
          colorScheme: "light",
          locale: "en-US",
          serviceWorkers: "block",
        },
        async ({ page }) => {
          const { thread } = await openActivity(
            page,
            key,
            [row(key, "Reader"), row(sourceKey, label)],
            [
              ...[
                "The verification receipt covers the original install and the saved-session replay. " +
                  "The team confirmed that all three migration checks completed without retrying any step. " +
                  "The original receipt contains the notes and final outcome.",
                "Receipt 2.\nSee notes.",
                Array.from({ length: 5 }, (_, index) => `Line ${index + 1}`).join(
                  "\r\n\u2028\u2029" + "\n".repeat(56),
                ),
              ].map((sourceSummary, index) => {
                const seq = index + 1;
                return delivery(
                  sourceKey,
                  seq === 1
                    ? "A longer original was sent. [Open verification notes](https://example.test/migration-notes)\n\n" +
                        Array.from(
                          { length: 32 },
                          (_, line) => `Verification detail ${line + 1}.`,
                        ).join("\n\n") +
                        "\n\nEnd of receipt 1"
                    : seq === 2
                      ? "Original receipt two.\n\n[Read the short receipt](https://example.test/short-receipt)"
                      : "End of receipt 3",
                  seq,
                  {
                    kind: "inter_session",
                    sourceTool: "sessions_send",
                    sourceSummary,
                  },
                  label,
                );
              }),
              turn(
                "assistant",
                Array.from(
                  { length: 36 },
                  (_, line) => `Later transcript paragraph ${line + 1}.`,
                ).join("\n\n"),
                2000,
              ),
            ],
          );
          await thread.getByText("Later transcript paragraph 36.", { exact: true }).waitFor();
          await thread.hover();
          await page.mouse.wheel(0, -3000);
          const group = page.locator(".chat-group--inter-session");
          const source = group.locator(".chat-group-messages > .chat-reply-attribution");
          const link = source.locator("a[data-session-key]");
          await link.getByText(label, { exact: true }).waitFor();
          const activity = group.locator(".chat-message-disclosure--description");
          expect(await group.count()).toBe(1);
          expect(await activity.count()).toBe(3);
          expect(await activity.locator("a[data-session-key]").count()).toBe(0);
          const geometry = () =>
            group.evaluate((element) => {
              const avatar = element
                .querySelector(".chat-avatar, .chat-avatar-slot")!
                .getBoundingClientRect();
              const bubble = element.querySelector(".chat-bubble")!.getBoundingClientRect();
              const from = element
                .querySelector(".chat-reply-attribution")!
                .getBoundingClientRect();
              return {
                avatarWidth: avatar.width,
                avatarRight: avatar.right,
                bubbleLeft: bubble.left,
                sourceLeft: from.left,
                sourceBottom: from.bottom,
                bubbleTop: bubble.top,
              };
            });
          const collapsed = await geometry();
          expect(collapsed.avatarWidth).toBeGreaterThan(0);
          expect(collapsed.avatarRight).toBeLessThan(collapsed.bubbleLeft);
          expect(Math.abs(collapsed.sourceLeft - collapsed.bubbleLeft)).toBeLessThan(1);
          expect(collapsed.sourceBottom).toBeLessThanOrEqual(collapsed.bubbleTop);
          const first = activity.first();
          const preview = first.locator(".chat-message-disclosure__content");
          const shortPreview = activity.nth(1).locator(".chat-message-disclosure__content");
          const toggle = first.locator(".chat-message-disclosure__toggle");
          if (width === 390) {
            await preview.and(first.locator("[data-preview-overflow]")).waitFor();
            expect(await preview.evaluate((node) => getComputedStyle(node).maskImage)).toContain(
              "linear-gradient",
            );
          } else {
            expect(await preview.evaluate((node) => getComputedStyle(node).maskImage)).toBe("none");
          }
          expect(await shortPreview.evaluate((node) => getComputedStyle(node).maskImage)).toBe(
            "none",
          );
          expect(await activity.nth(1).getByRole("button", { name: "Show more" }).isVisible()).toBe(
            true,
          );
          expect(await first.locator("summary, .chat-session-activity__chevron").count()).toBe(0);
          const sparse = activity.nth(2).locator(".chat-message-disclosure__content");
          expect(await sparse.evaluate((node) => getComputedStyle(node).maskImage)).toBe("none");
          const legacyLines = await sparse
            .locator(".chat-message-disclosure__description")
            .evaluate((node) => {
              const text = document.createRange();
              text.selectNodeContents(node);
              return new Set(
                [...text.getClientRects()].filter((rect) => rect.width > 0).map((rect) => rect.top),
              ).size;
            });
          expect(legacyLines).toBeLessThan(3);
          expect(await toggle.textContent()).toBe("Show more");
          expect(await toggle.getAttribute("aria-expanded")).toBe("false");
          const placement = await first.evaluate((node) => {
            const button = node.querySelector("button")!.getBoundingClientRect();
            const content = node
              .querySelector(".chat-message-disclosure__content")!
              .getBoundingClientRect();
            return {
              underneath: button.top >= content.bottom,
              alignedLeft: Math.abs(button.left - content.left) < 1,
            };
          });
          expect(placement).toEqual({ underneath: true, alignedLeft: true });
          const toggleElement = await toggle.elementHandle();
          await toggle.focus();
          await toggle.press("Enter");
          await first.getByText(/End of receipt 1$/).waitFor();
          expect(await toggle.textContent()).toBe("Show less");
          expect(await toggle.getAttribute("aria-expanded")).toBe("true");
          expect(
            await toggle.evaluate((button) => {
              const original = document.getElementById(button.getAttribute("aria-controls")!);
              return (
                original?.nextElementSibling === button &&
                original.getBoundingClientRect().bottom <= button.getBoundingClientRect().top &&
                original.querySelectorAll("p").length > 1
              );
            }),
          ).toBe(true);
          expect(
            await toggle.evaluate((button, original) => button === original, toggleElement),
          ).toBe(true);
          await expect
            .poll(
              () =>
                toggle.evaluate(
                  (button) => document.activeElement?.id === button.getAttribute("aria-controls"),
                ),
              { message: "keyboard expansion focuses the original before its first link" },
            )
            .toBe(true);
          await page.keyboard.press("Tab");
          expect(
            await first
              .getByRole("link", { name: "Open verification notes" })
              .evaluate((originalLink) => document.activeElement === originalLink),
          ).toBe(true);
          expect(await activity.nth(1).locator("button").getAttribute("aria-expanded")).toBe(
            "false",
          );
          expect(
            await preview.evaluate((node) => ({
              mask: getComputedStyle(node).maskImage,
              clipped: node.scrollHeight > node.clientHeight + 1,
            })),
          ).toEqual({ mask: "none", clipped: false });
          expect((await geometry()).bubbleLeft).toBeCloseTo(collapsed.bubbleLeft, 0);
          expect(
            await first.locator(".chat-message-disclosure__original").evaluate((body) => {
              const css = getComputedStyle(body);
              return [css.borderTopWidth, css.borderLeftWidth];
            }),
          ).toEqual(["0px", "0px"]);
          expect(await first.locator(".chat-reply-attribution, .chat-bubble").count()).toBe(0);
          await toggle.scrollIntoViewIfNeeded();
          await toggle.press("Space");
          await first.getByText(/End of receipt 1$/).waitFor({ state: "detached" });
          expect(await toggle.textContent()).toBe("Show more");
          await expect
            .poll(() =>
              toggle.evaluate((button) => {
                const box = button.getBoundingClientRect();
                const threadBounds = button.closest(".chat-thread")!.getBoundingClientRect();
                return {
                  focused: document.activeElement === button,
                  visible: box.top >= threadBounds.top && box.bottom <= threadBounds.bottom,
                };
              }),
            )
            .toEqual({ focused: true, visible: true });
          const compact = activity.nth(1);
          const compactToggle = compact.getByRole("button", { name: "Show more" });
          const widthGeometry = () =>
            compact.evaluate((element) => {
              const bubble = element.closest(".chat-bubble")!.getBoundingClientRect();
              const column = element.closest(".chat-group-messages")!.getBoundingClientRect();
              const description = element
                .querySelector(".chat-message-disclosure__description")!
                .getBoundingClientRect();
              const original = element
                .querySelector(".chat-message-disclosure__original")
                ?.getBoundingClientRect();
              return {
                bubbleWidth: bubble.width,
                bubbleLeft: bubble.left,
                bubbleRight: bubble.right,
                columnWidth: column.width,
                columnRight: column.right,
                descriptionWidth: description.width,
                descriptionLeft: description.left,
                originalWidth: original?.width,
                originalLeft: original?.left,
                pageOverflow: document.documentElement.scrollWidth > innerWidth,
              };
            });
          const narrow = await widthGeometry();
          const closedSiblingWidth = await sparse.evaluate((element) => element.clientWidth);
          expect(narrow.bubbleWidth).toBeLessThan(narrow.columnWidth - 24);
          await compactToggle.click();
          await compact.getByText("Original receipt two.", { exact: true }).waitFor();
          await expect
            .poll(() =>
              compact.evaluate(
                (entry) =>
                  entry.contains(document.activeElement) &&
                  document.activeElement?.id ===
                    entry.querySelector("button")?.getAttribute("aria-controls"),
              ),
            )
            .toBe(true);
          await page.keyboard.press("Tab");
          expect(
            await compact
              .getByRole("link", { name: "Read the short receipt" })
              .evaluate((originalLink) => document.activeElement === originalLink),
          ).toBe(true);
          const wide = await widthGeometry();
          expect(wide.bubbleRight).toBeCloseTo(wide.columnRight, 0);
          expect(wide.bubbleLeft).toBeCloseTo(narrow.bubbleLeft, 0);
          expect(wide.descriptionWidth).toBeCloseTo(wide.originalWidth!, 0);
          expect(wide.descriptionLeft).toBeCloseTo(wide.originalLeft!, 0);
          expect(wide.pageOverflow).toBe(false);
          expect(await sparse.evaluate((element) => element.clientWidth)).toBe(closedSiblingWidth);
          await compact.getByRole("button", { name: "Show less" }).press("Space");
          await compact
            .getByText("Original receipt two.", { exact: true })
            .waitFor({ state: "detached" });
          expect((await widthGeometry()).bubbleWidth).toBeCloseTo(narrow.bubbleWidth, 0);

          const pane = page.locator(".chat-pane-cache__pane--active");
          await pane.locator(".agent-chat__composer-combobox textarea").focus();
          const findShortcut = await page.evaluate(() =>
            /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta+f" : "Control+f",
          );
          await page.keyboard.press(findShortcut);
          await pane
            .getByRole("textbox", { name: "Search loaded messages" })
            .fill("Original receipt two.");
          const searchEntry = activity.first();
          await expect.poll(() => activity.count()).toBe(1);
          await searchEntry.getByText("Original receipt two.", { exact: true }).waitFor();
          expect(await searchEntry.locator(disclosure).count()).toBe(0);
          const searchGap = await searchEntry.evaluate(
            (entry) =>
              entry.closest(".chat-group-messages")!.getBoundingClientRect().right -
              entry.closest(".chat-bubble")!.getBoundingClientRect().right,
          );
          expect(searchGap).toBeCloseTo(0, 0);
          await pane.getByRole("button", { name: "Close search", exact: true }).click();
          await link.click();
          await page.waitForURL((url) => url.pathname.includes("activity-source"));
        },
      );
    },
  );
});
