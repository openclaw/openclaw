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
          await openActivity(
            page,
            key,
            [row(key, "Reader"), row(sourceKey, label)],
            [1, 2, 3].map((seq) =>
              delivery(
                sourceKey,
                "Receipt " + seq + ": Verification detail. End of receipt " + seq,
                seq,
                {
                  kind: "inter_session",
                  sourceTool: "sessions_send",
                  sourceSummary: "Receipt " + seq + " verified",
                },
                label,
              ),
            ),
          );
          const group = page.locator(".chat-group--inter-session");
          const source = group.locator(".chat-group-messages > .chat-reply-attribution");
          const link = source.locator("a[data-session-key]");
          await link.getByText(label, { exact: true }).waitFor();
          const activity = group.locator(".chat-session-activity");
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
          const summary = first.locator("summary");
          expect(await summary.textContent()).toBe("Receipt 1 verified");
          await summary.focus();
          await summary.press("Enter");
          await first.getByText(/End of receipt 1$/).waitFor();
          expect(await activity.nth(1).getAttribute("open")).toBeNull();
          const expanded = await geometry();
          expect(expanded.bubbleLeft).toBeCloseTo(collapsed.bubbleLeft, 0);
          expect(
            await first.locator(".chat-session-activity__body").evaluate((body) => {
              const css = getComputedStyle(body);
              return [css.borderTopWidth, css.borderLeftWidth];
            }),
          ).toEqual(["0px", "0px"]);
          expect(await first.locator(".chat-reply-attribution, .chat-bubble").count()).toBe(0);
          await summary.press("Space");
          await first.getByText(/End of receipt 1$/).waitFor({ state: "detached" });
          await link.click();
          await page.waitForURL((url) => url.pathname.includes("activity-source"));
        },
      );
    },
  );
});
