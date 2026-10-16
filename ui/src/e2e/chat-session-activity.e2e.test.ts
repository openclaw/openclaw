import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("keeps automation prompts compact with keyboard disclosure and exact run navigation", async () => {
    const sessionKey = "agent:main:dashboard:automation-view";
    const artifacts = createControlUiE2eArtifactDir("automation-activity");
    await suite.withPage(
      { viewport: { width: 1440, height: 1000 }, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        await installMockGateway(page, {
          sessionKey,
          sessions: [
            { key: sessionKey, kind: "direct", displayName: "Review pull request", updatedAt: 1 },
          ],
          historyMessages: [
            {
              role: "user",
              content: "Check this pull request and land it when it is ready.",
              timestamp: 1000,
            },
            ...["Auto-fix CI and address comments", "Auto-merge when ready"].map(
              (label, index) => ({
                role: "assistant",
                timestamp: 2000 + index,
                content:
                  "Run one bounded " +
                  label +
                  " check for this exact target: " +
                  JSON.stringify({ owner: "example", repo: "project", number: 42 }) +
                  "\n\nVerify the current pull request, inspect required checks, and preserve the review gates. ".repeat(
                    15,
                  ) +
                  "End of automation prompt.",
                provenance: {
                  kind: "internal_system",
                  sourceTool: "cron",
                  jobId: "job-" + index,
                  runId: "run-" + index,
                  sourceSessionKey: sessionKey,
                },
                senderSession: { sessionKey, agentId: "main", label },
                __openclaw: { id: "automation-" + index, seq: index + 2, turnBoundary: true },
              }),
            ),
            {
              role: "assistant",
              content: "The checks are passing. The pull request is ready to merge.",
              timestamp: 4000,
              phase: "final_answer",
              __openclaw: { id: "answer", seq: 4, runId: "answer-run" },
            },
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const thread = page.locator(".chat-thread");
        const answer = page.getByText(
          "The checks are passing. The pull request is ready to merge.",
          { exact: true },
        );
        await answer.waitFor();
        const frame = await takeControlUiScreenshotFrame(page, thread, [answer], {
          animations: "disabled",
          elements: [thread],
        });
        await writeFile(path.join(artifacts, "desktop.png"), frame.elements[0]!.png);
        const activity = page.locator(".chat-session-activity");
        expect(await activity.count()).toBe(2);
        expect(await page.locator(".chat-group--forwarded").count()).toBe(0);
        const first = activity.first();
        const summary = first.locator("summary");
        expect(await summary.textContent()).toContain("Auto-fix CI and address comments");
        expect(await summary.locator("a[data-cron-run-link]").getAttribute("href")).toBe(
          "/automations?job=job-0&run=run-0",
        );
        expect(await first.locator(".chat-session-activity__message").count()).toBe(0);
        await summary.focus();
        await summary.press("Enter");
        await first.getByText(/End of automation prompt.$/).waitFor();
        expect(await first.locator("a[data-cron-run-link]").getAttribute("href")).toBe(
          "/automations?job=job-0&run=run-0",
        );
        expect(await first.locator(".chat-message-disclosure__toggle").count()).toBe(0);
        await summary.press("Space");
        await first.locator(".chat-session-activity__message").waitFor({ state: "detached" });
        const mobile = await takeControlUiScreenshotFrame(page, thread, [summary, answer], {
          animations: "disabled",
          viewport: { width: 390, height: 844 },
        });
        await writeFile(path.join(artifacts, "mobile.png"), mobile.png);
        await first.locator("a[data-cron-run-link]").click();
        await page.waitForURL(
          (url) =>
            url.pathname.endsWith("/automations") &&
            url.searchParams.get("job") === "job-0" &&
            url.searchParams.get("run") === "run-0",
        );
      },
    );
  });
  it("keeps one automation summary across disclosure states and opens its run without toggling", async () => {
    const sessionKey = "agent:main:dashboard:automation-summary";
    const artifacts = createControlUiE2eArtifactDir("automation-activity-summary");
    await suite.withPage(
      {
        viewport: { width: 1280, height: 800 },
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        await installMockGateway(page, {
          sessionKey,
          sessions: [
            { key: sessionKey, kind: "direct", displayName: "Morning briefing", updatedAt: 1 },
          ],
          historyMessages: [
            {
              role: "user",
              content: "Send me a short briefing every morning.",
              timestamp: 1000,
            },
            {
              role: "assistant",
              timestamp: 2000,
              content:
                "Summarize overnight pull request activity and failing checks in three bullets.",
              provenance: {
                kind: "internal_system",
                sourceTool: "cron",
                jobId: "morning-briefing",
                runId: "run-7",
                sourceSessionKey: sessionKey,
              },
              // Cron deliveries carry no session title, so the source reads as "Automation".
              senderSession: { sessionKey, agentId: "main" },
              __openclaw: { id: "automation-run-7", seq: 2, turnBoundary: true },
            },
            {
              role: "assistant",
              content: "Two pull requests merged overnight and all checks are green.",
              timestamp: 3000,
              phase: "final_answer",
              __openclaw: { id: "briefing", seq: 3, runId: "briefing-run" },
            },
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const thread = page.locator(".chat-thread");
        const answer = page.getByText(
          "Two pull requests merged overnight and all checks are green.",
          { exact: true },
        );
        await answer.waitFor();
        const activity = page.locator(".chat-session-activity");
        const summary = activity.locator("summary");
        const capture = async (state: "collapsed" | "expanded") => {
          const frame = await takeControlUiScreenshotFrame(page, thread, [summary, answer], {
            animations: "disabled",
            elements: [thread, summary],
          });
          await writeFile(path.join(artifacts, state + ".png"), frame.elements[0]!.png);
          await writeFile(path.join(artifacts, state + "-summary.png"), frame.elements[1]!.png);
          return summary.evaluate((element) => {
            const attribution = element.querySelector(".chat-reply-attribution");
            const source = element.querySelector<HTMLElement>("a[data-cron-run-link]");
            return {
              // Lit part markers are bookkeeping, not rendered markup.
              markup: element.innerHTML.replace(/<!--[^]*?-->/gu, ""),
              text: element.textContent?.replace(/\s+/gu, " ").trim(),
              width: attribution?.getBoundingClientRect().width,
              sourceColor: source ? getComputedStyle(source).color : null,
            };
          });
        };
        expect(await activity.count()).toBe(1);
        expect(await activity.locator(".chat-session-activity__message").count()).toBe(0);
        const collapsed = await capture("collapsed");
        await summary.getByText("1 update from", { exact: true }).click();
        await activity.getByText(/in three bullets\.$/u).waitFor();
        const expanded = await capture("expanded");
        expect(collapsed.text).toBe("1 update from Automation");
        expect(expanded).toEqual(collapsed);
        await summary.focus();
        await summary.press("Enter");
        await activity.locator(".chat-session-activity__message").waitFor({ state: "detached" });
        const runLink = summary.locator("a[data-cron-run-link]");
        expect(await runLink.getAttribute("href")).toBe(
          "/automations?job=morning-briefing&run=run-7",
        );
        expect(await runLink.locator(".session-link-icon svg").count()).toBe(1);
        const toggles = await activity.evaluateHandle((details) => {
          const observed = { count: 0 };
          new MutationObserver((records) => {
            observed.count += records.length;
          }).observe(details, { attributeFilter: ["open"] });
          return observed;
        });
        await runLink.click();
        await page.waitForURL(
          (url) =>
            url.pathname.endsWith("/automations") &&
            url.searchParams.get("job") === "morning-briefing" &&
            url.searchParams.get("run") === "run-7",
        );
        expect(await toggles.evaluate((observed) => observed.count)).toBe(0);
      },
    );
  });
  it("resolves a collapsed source title and opens original receipts with one click or keyboard", async () => {
    const sessionKey = "agent:main:activity-reader";
    const sourceKey = "agent:main:activity-source";
    const sourceLabel = "Verification session";
    await suite.withPage(
      { viewport: { width: 390, height: 844 }, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        await installMockGateway(page, {
          sessionKey,
          sessions: [
            { key: sessionKey, kind: "direct", displayName: "Reader", updatedAt: 1 },
            { key: sourceKey, kind: "direct", displayName: sourceLabel, updatedAt: 1 },
          ],
          historyMessages: [1, 2, 3].map((seq) => ({
            role: "assistant",
            timestamp: 1000 + seq,
            content:
              "Receipt " +
              seq +
              ": " +
              "Verification detail. ".repeat(100) +
              "End of receipt " +
              seq,
            provenance: {
              kind: "inter_session",
              sourceTool: "sessions_send",
              sourceSessionKey: sourceKey,
            },
            // Ordinary sends carry source identity, not a pre-resolved session title.
            senderSession: { sessionKey: sourceKey, agentId: "main" },
            __openclaw: { id: "receipt-" + seq, seq, runId: "run-" + seq, turnBoundary: true },
          })),
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const activity = page.locator(".chat-session-activity");
        const summary = activity.locator("summary");
        await summary.getByText(sourceLabel, { exact: true }).waitFor();
        expect(await activity.count()).toBe(1);
        expect(await summary.locator("a[data-session-key]").count()).toBe(1);
        expect(await activity.locator(".chat-bubble").count()).toBe(0);
        await summary.getByText("3 updates from", { exact: true }).click();
        await activity.getByText(/End of receipt 3$/).waitFor();
        expect(await activity.locator(".chat-reply-attribution").count()).toBe(1);
        expect(await summary.getByText("3 updates from", { exact: true }).count()).toBe(1);
        expect(await summary.getByText("From", { exact: true }).count()).toBe(0);
        expect(
          await activity.locator(".chat-session-activity__body .chat-reply-attribution").count(),
        ).toBe(0);
        expect(await activity.locator(".chat-message-disclosure__toggle").count()).toBe(0);
        await summary.focus();
        await summary.press("Enter");
        await activity.getByText(/End of receipt 3$/).waitFor({ state: "detached" });
        await summary.press("Space");
        await activity.getByText(/End of receipt 3$/).waitFor();
        await activity.locator("a[data-session-key]").click();
        await page.waitForURL((url) => url.pathname.includes("activity-source"));
      },
    );
  });
});
