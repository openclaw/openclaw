import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import {
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  captureUiProofEnabled,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { tooltipTitleText } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionKey = "agent:main:dashboard:automation-proof";
const jobId = "museum-ci-watch";
const label = "Watch museum CI and review comments";
const now = 1_792_512_000_000;
const prompt = "Check museum CI and new review comments; continue only when actionable.";
const activity = (page: Page) => page.locator(".chat-automation-activity");
function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: jobId,
    name: label,
    agentId: "main",
    sessionKey,
    enabled: true,
    createdAtMs: now - 600_000,
    updatedAtMs: now,
    configRevision: "automation-v1",
    schedule: { kind: "every", everyMs: 300_000 },
    sessionTarget: `session:${sessionKey}`,
    wakeMode: "now",
    payload: { kind: "agentTurn", message: prompt },
    state: { nextRunAtMs: now + 300_000, lastRunAtMs: now, lastRunStatus: "ok" },
    ...overrides,
  };
}
function inventory(jobs: CronJob[]) {
  return cronListResponseFixture({
    jobs,
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
    snapshotRevision: "automation-proof",
  });
}
function invocation(index: number, id = jobId, source = sessionKey) {
  const runId = `museum-run-${index}`;
  const seq = index * 10;
  const metadata = (offset: number) => ({
    id: `museum-${index}-${offset}`,
    seq: seq + offset,
    runId,
  });
  return [
    {
      role: "assistant",
      content: prompt,
      timestamp: now - 1_200_000 + index * 300_000,
      provenance: {
        kind: "internal_system",
        sourceTool: "cron",
        sourceSessionKey: source,
        jobId: id,
        runId,
      },
      senderSession: { sessionKey: source, agentId: "main", label },
      __openclaw: { ...metadata(0), turnBoundary: true },
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: `museum-call-${index}`,
          name: "exec",
          arguments: { command: "verify-museum-ci --read-only" },
        },
      ],
      timestamp: now - 1_200_000 + index * 300_000 + 100,
      stopReason: "toolUse",
      runId,
      __openclaw: metadata(1),
    },
    {
      role: "toolResult",
      content: "No actionable changes.",
      toolCallId: `museum-call-${index}`,
      toolName: "exec",
      timestamp: now - 1_200_000 + index * 300_000 + 200,
      isError: false,
      runId,
      __openclaw: metadata(2),
    },
  ];
}
const history = () => [
  {
    role: "user",
    content: "Watch the museum pull request while I prepare the release.",
    timestamp: now - 1_500_000,
    __openclaw: { id: "museum-human", seq: 1 },
  },
  {
    role: "assistant",
    content: "I will watch CI and review comments and keep useful results visible.",
    timestamp: now - 1_400_000,
    phase: "final_answer",
    stopReason: "stop",
    __openclaw: { id: "museum-ready", seq: 2 },
  },
  ...[1, 2, 3, 4].flatMap((index) => invocation(index)),
];
async function capture(
  page: Page,
  directory: string | undefined,
  name: string,
  content: ReturnType<Page["locator"]>[],
) {
  if (!directory) {
    return;
  }
  const frame = await takeControlUiScreenshotFrame(page, page.locator(".chat-thread"), content, {
    animations: "disabled",
    elements: [page.locator(".chat-thread")],
  });
  await writeFile(path.join(directory, `${name}.png`), frame.png);
  await writeFile(path.join(directory, `${name}-transcript.png`), frame.elements[0]!.png);
}

suite.define(() => {
  it("folds repeated tool-only automation runs without losing their original inputs", async () => {
    const directory = captureUiProofEnabled
      ? createControlUiE2eArtifactDir(
          "automation-activity",
          path.resolve(".openclaw/tmp/automation-proof"),
        )
      : undefined;
    await suite.withPage(
      {
        viewport: { width: 1440, height: 1000 },
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        await page.clock.setFixedTime(now);
        const gateway = await installMockGateway(page, {
          sessionKey,
          sessions: [
            { key: sessionKey, kind: "direct", label: "Museum release review", updatedAt: now },
          ],
          historyMessages: history(),
          methodResponses: {
            "cron.list": inventory([job()]),
            "cron.status": { enabled: true, triggersEnabled: true, jobs: 1 },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page
          .getByText("I will watch CI and review comments and keep useful results visible.", {
            exact: true,
          })
          .waitFor();
        await expect.poll(() => activity(page).count()).toBe(1);
        const summary = activity(page).locator(":scope > summary");
        await expect
          .poll(() => activity(page).locator(".chat-automation-activity__status").textContent())
          .toContain("Scheduled");
        expect(await page.getByText("Interrupted", { exact: true }).count()).toBe(0);
        await capture(page, directory, "after-desktop-dark", [summary]);
        await summary.focus();
        await summary.press("Enter");
        await expect.poll(() => activity(page).getAttribute("open")).not.toBeNull();
        await expect.poll(() => activity(page).getByText(prompt, { exact: true }).count()).toBe(4);
        for (const original of await activity(page).getByText(prompt, { exact: true }).all()) {
          expect(await original.isVisible()).toBe(true);
        }
        await capture(page, directory, "after-expanded", [summary]);
        await expect.poll(() => activity(page).locator(".chat-tool-row").count()).toBe(4);
        expect(
          await page
            .locator(".chat-automation-activity__body")
            .getByText("Interrupted", { exact: true })
            .count(),
        ).toBe(4);
        const status = activity(page).locator(".chat-automation-activity__status");
        const expectStatus = (text: string) =>
          expect.poll(() => status.textContent()).toContain(text);
        await expectStatus("Scheduled");
        const update = async (next: CronJob, action: string) => {
          await gateway.setMethodResponse("cron.list", inventory([next]));
          await gateway.emitGatewayEvent("cron", { action, jobId, job: next });
        };
        await summary.focus();
        await update(job({ updatedAtMs: now + 1, state: { runningAtMs: now + 1 } }), "started");
        await expectStatus("Checking now");
        expect(await activity(page).getAttribute("open")).not.toBeNull();
        expect(await summary.evaluate((element) => element === document.activeElement)).toBe(true);
        await capture(page, directory, "running", [summary]);
        await update(
          job({
            updatedAtMs: now + 2,
            state: { lastRunStatus: "error", lastError: "Museum CI is unavailable." },
          }),
          "finished",
        );
        await expectStatus("Needs attention");
        await capture(page, directory, "error", [summary]);
        await update(job({ enabled: false, updatedAtMs: now + 3, state: {} }), "updated");
        await expectStatus("Paused");
        await summary.press("Space");
        await expect.poll(() => activity(page).getAttribute("open")).toBeNull();
        await capture(page, directory, "paused", [summary]);
        await gateway.setOnline(false);
        await expectStatus("Offline");
        expect(await summary.isVisible()).toBe(true);
        await gateway.setOnline(true);
        await expectStatus("Paused");
        await gateway.setMethodResponse("cron.list", inventory([]));
        await gateway.emitGatewayEvent("cron", { action: "removed", jobId });
        await expectStatus("Status unavailable");
        await capture(page, directory, "deleted", [summary]);
        await gateway.setMethodResponse("cron.list", inventory([job()]));
        await page.reload();
        await expect.poll(() => activity(page).count()).toBe(1);
        await expectStatus("Scheduled");
        await expect.poll(() => activity(page).getAttribute("open")).toBeNull();
        await page.emulateMedia({ colorScheme: "light" });
        await capture(page, directory, "after-desktop-light", [summary]);
      },
    );
  });

  it("keeps long automation labels compact on mobile with the complete title available", async () => {
    const directory = captureUiProofEnabled
      ? createControlUiE2eArtifactDir(
          "automation-mobile-compact",
          path.resolve(".openclaw/tmp/automation-proof"),
        )
      : undefined;
    await suite.withPage(
      {
        viewport: { width: 390, height: 844 },
        colorScheme: "light",
        locale: "en-US",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        await page.clock.setFixedTime(now);
        const gateway = await installMockGateway(page, {
          sessionKey,
          sessions: [
            { key: sessionKey, kind: "direct", label: "Museum release review", updatedAt: now },
          ],
          historyMessages: history(),
          methodResponses: { "cron.list": inventory([job()]) },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const summary = activity(page).locator(":scope > summary");
        const title = activity(page).locator(".chat-automation-activity__label");
        await expect
          .poll(() => activity(page).locator(".chat-automation-activity__status").textContent())
          .toContain("Scheduled");
        const longLabel = "Museum CI — " + "release-review-and-approval-".repeat(12);
        const next = job({ name: longLabel, updatedAtMs: now + 4 });
        await gateway.setMethodResponse("cron.list", inventory([next]));
        await gateway.emitGatewayEvent("cron", { action: "updated", jobId, job: next });
        await expect.poll(() => title.textContent()).toBe(longLabel);
        expect(await tooltipTitleText(title)).toBe(longLabel);
        const compact = () =>
          title.evaluate((element) => {
            const style = getComputedStyle(element);
            const box = element.getBoundingClientRect();
            const thread = element.closest(".chat-thread")!.getBoundingClientRect();
            return (
              box.height <= Number.parseFloat(style.lineHeight) + 1 &&
              element.scrollWidth > element.clientWidth &&
              style.textOverflow === "ellipsis" &&
              box.left >= thread.left &&
              box.right <= thread.right + 1
            );
          });
        await expect.poll(compact).toBe(true);
        await expect
          .poll(() =>
            summary.evaluate((element) => {
              const box = element.getBoundingClientRect();
              return box.height <= 64 && element.scrollWidth <= element.clientWidth + 1;
            }),
          )
          .toBe(true);
        await capture(page, directory, "after-mobile-light-long-label", [summary]);
        await page.emulateMedia({ colorScheme: "dark" });
        await expect.poll(compact).toBe(true);
        await capture(page, directory, "after-mobile-dark-long-label", [summary]);
      },
    );
  });

  it("keeps human inputs, visible results and errors outside chronological automation blocks", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 1000 }, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        const barrier = (content: string, role: string, seq: number, extra = {}) => ({
          role,
          content,
          timestamp: now + seq,
          __openclaw: { id: "barrier-" + seq, seq },
          ...extra,
        });
        const gateway = await installMockGateway(page, {
          sessionKey,
          historyMessages: [
            ...invocation(1),
            ...invocation(2),
            barrier("Show me the actual CI results.", "user", 29),
            ...invocation(3),
            barrier("The museum checks are passing.", "assistant", 39, {
              phase: "final_answer",
              stopReason: "stop",
              runId: "museum-run-3",
            }),
            ...invocation(4),
            barrier("Museum review needs human approval.", "assistant", 49, {
              stopReason: "error",
              errorMessage: "Museum review needs human approval.",
              runId: "museum-run-4",
            }),
            ...invocation(5),
            ...invocation(6, "different-job"),
            ...invocation(7, "different-job", "agent:main:dashboard:another-source"),
          ],
          methodResponses: {
            "cron.list": inventory([job()]),
            "cron.status": { enabled: true, triggersEnabled: true, jobs: 1 },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        for (const text of [
          "Show me the actual CI results.",
          "The museum checks are passing.",
          "Museum review needs human approval.",
        ]) {
          await page.getByText(text, { exact: true }).first().waitFor();
          expect(
            await page
              .getByText(text, { exact: true })
              .first()
              .evaluate((element) => element.closest(".chat-automation-activity") === null),
          ).toBe(true);
        }
        // Every visible boundary, different job and different source keeps its chronological block.
        await expect.poll(() => activity(page).count()).toBe(6);
        const first = activity(page).first();
        await first.locator(":scope > summary").click();
        await expect.poll(() => first.getByText(prompt, { exact: true }).count()).toBe(2);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      },
    );
  });

  it("reveals original automation messages for transcript search and reply navigation", async () => {
    await suite.withPage(
      { viewport: { width: 1180, height: 960 }, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        const sourceId = "museum-2-0";
        const followup = {
          role: "user",
          content: "Explain this automation check.",
          timestamp: now + 200,
          __openclaw: { id: "museum-question", seq: 30, replyToId: sourceId },
        };
        const gateway = await installMockGateway(page, {
          sessionKey,
          historyMessages: [...invocation(1), ...invocation(2), followup],
          methodResponses: { "cron.list": inventory([job()]) },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const pane = page.locator(".chat-pane-cache__pane--active");
        const source = pane.locator('[data-entry-id="' + sourceId + '"].chat-bubble');
        await pane.getByText("Explain this automation check.", { exact: true }).waitFor();
        expect(await source.count()).toBe(0);
        await pane.locator(".chat-reply-attribution--inline button").click();
        await source.waitFor({ state: "visible" });
        await expect
          .poll(() => source.getAttribute("class"))
          .toContain("chat-bubble--reply-target");
        expect(await source.textContent()).toContain(prompt);
        await activity(page).locator(":scope > summary").click();
        await expect.poll(() => source.count()).toBe(0);
        await pane.locator(".agent-chat__composer-combobox textarea").focus();
        await page.keyboard.press(
          await page.evaluate(() =>
            /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta+f" : "Control+f",
          ),
        );
        await pane.getByRole("textbox", { name: "Search messages", exact: true }).fill(prompt);
        await source.waitFor({ state: "visible" });
        expect(await source.textContent()).toContain(prompt);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      },
    );
  });

  it.each([false, true])(
    "retains original checks when automation inventory is unavailable (session-only=%s)",
    async (sessionOnly) => {
      const directory = captureUiProofEnabled
        ? createControlUiE2eArtifactDir(
            "automation-unavailable",
            path.resolve(".openclaw/tmp/automation-proof"),
          )
        : undefined;
      await suite.withPage(
        {
          viewport: { width: 390, height: 844 },
          locale: "en-US",
          colorScheme: "light",
          serviceWorkers: "block",
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            sessionKey,
            operatorScopes: sessionOnly
              ? ["operator.sessions.read", "operator.sessions.write"]
              : undefined,
            historyMessages: history(),
            methodResponses: {
              "cron.list": {
                __mockError: {
                  code: "FORBIDDEN",
                  message: "Automation inventory access is restricted.",
                },
              },
            },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await expect.poll(() => activity(page).count()).toBe(1);
          const summary = activity(page).locator(":scope > summary");
          await expect
            .poll(() => activity(page).locator(".chat-automation-activity__status").textContent())
            .toContain(sessionOnly ? "4 checks" : "Status unavailable");
          expect(await summary.textContent()).not.toContain("Scheduled");
          await summary.focus();
          await summary.press("Enter");
          await expect
            .poll(() => activity(page).getByText(prompt, { exact: true }).count())
            .toBe(4);
          await summary.press("Enter");
          await expect.poll(() => activity(page).getAttribute("open")).toBeNull();
          await capture(page, directory, "permission-fallback-mobile", [summary]);
          if (sessionOnly) {
            expect(await gateway.getRequests("cron.list")).toHaveLength(0);
          }
          expect(await gateway.getRequests("cron.update")).toHaveLength(0);
        },
      );
    },
  );
});
