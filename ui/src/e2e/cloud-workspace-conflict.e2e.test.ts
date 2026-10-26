import type { Page } from "playwright";
import { assert, expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createDarkDesktopControlUiContextOptions } from "./control-ui-browser-options.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cloud workspace conflict recovery",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
const sessionKey = "agent:main:conflict-proof";
const workerFailureDiagnostic = [
  "Worker provider rejected profile: node enrollment setup failed with exit code 1: provider reported lease destroyed",
  "<img src=x onerror=alert(1)>",
  `Trace: ${"diagnostic-segment/".repeat(100)}`,
  ...Array.from({ length: 30 }, (_, index) => `    at enroll (worker.ts:${index + 1}:1)`),
  "Final diagnostic line: enrollment did not complete.",
].join("\n");

const conflict = {
  paths: ["src/local.ts", "ui/src/app.ts"],
  stagedResultRef: "refs/openclaw/worker-results/claim-proof",
  totalCount: 2,
};

const pageOptions = createDarkDesktopControlUiContextOptions();
function sessionList(label: string, placement: Record<string, unknown>, now = Date.now()) {
  const model = { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" };
  return {
    count: 1,
    defaults: model,
    path: "",
    ts: now,
    sessions: [
      {
        ...model,
        displayName: label,
        label,
        key: sessionKey,
        kind: "direct",
        hasActiveRun: false,
        status: "done",
        totalTokens: 0,
        updatedAt: now,
        placement: {
          createdAtMs: now - 10_000,
          updatedAtMs: now,
          stateChangedAtMs: now - 1_000,
          ...placement,
        },
      },
    ],
  };
}
function sessionsList(includeConflict: boolean) {
  return sessionList(includeConflict ? "Cloud conflict proof" : "Cloud conflict cleared", {
    state: "reclaimed",
    generation: 1,
    ...(includeConflict ? { workspaceResultConflict: conflict } : {}),
  });
}
function workerRecoverySessionsList(includeError: boolean, failedState = "failed") {
  const now = Date.now();
  return sessionList(
    "Cloud worker failure proof",
    {
      state: includeError ? failedState : "active",
      generation: 2,
      environmentId: "worker:lost-proof",
      activeOwnerEpoch: 4,
      ...(includeError
        ? {
            recoveryError: workerFailureDiagnostic,
            terminalReason:
              failedState === "failed" ? "stale terminal worker failure" : workerFailureDiagnostic,
            terminalAtMs: now,
          }
        : {}),
    },
    now,
  );
}

type History = NonNullable<Parameters<typeof installMockGateway>[1]>["historyMessages"];
const historyEvent = (customType: string, content: string, details?: unknown) => ({
  role: "custom",
  customType,
  content,
  details,
  timestamp: Date.now() - 500,
});
async function openSession(
  page: Page,
  historyMessages: History,
  roster = workerRecoverySessionsList(false),
) {
  const gateway = await installMockGateway(page, {
    historyMessages,
    methodResponses: { "sessions.list": roster },
    sessionKey,
  });
  expect((await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey)))?.status()).toBe(
    200,
  );
  return gateway;
}

suite.define(() => {
  it("shows, dismisses, and reloads durable conflict recovery guidance", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const gateway = await openSession(
        page,
        [historyEvent("cloud-workspace-conflict", "2 cloud conflicts.", conflict)],
        sessionsList(true),
      );

      const notice = page.locator(".chat-workspace-conflict-notice");
      const sessionRow = page.locator(`[data-session-key="${sessionKey}"]`);
      await notice.waitFor({ timeout: 10_000 });
      await sessionRow.locator('.session-row-badge--cloud[data-workspace-conflicts="2"]').waitFor();
      const historyCard = page.locator(".chat-workspace-conflict-event");
      await historyCard.waitFor();
      expect(await notice.textContent()).toContain("2 cloud workspace conflicts");
      expect(await historyCard.textContent()).toContain(conflict.stagedResultRef);

      await page.setViewportSize({ width: 390, height: 844 });
      const composer = page.locator(".agent-chat__composer-shell");
      const title = notice.locator(".chat-composer-neighbor-card__copy strong");
      const summary = notice.locator(".chat-composer-neighbor-card__copy > span");
      const dismiss = notice.getByRole("button", { name: "Dismiss workspace conflict notice" });
      await expect
        .poll(async () => {
          const [composerBox, noticeBox] = await Promise.all([
            composer.boundingBox(),
            notice.boundingBox(),
          ]);
          return composerBox && noticeBox ? Math.abs(composerBox.width - noticeBox.width) : null;
        })
        .toBeLessThanOrEqual(1);
      await expect
        .poll(() =>
          title.evaluate((node) =>
            [node, node.nextElementSibling!].map((item) => getComputedStyle(item).whiteSpace),
          ),
        )
        .toEqual(["nowrap", "nowrap"]);
      for (const item of [title, summary, dismiss]) {
        const [itemBox, noticeBox] = await Promise.all([item.boundingBox(), notice.boundingBox()]);
        assert(itemBox && noticeBox, "expected mobile conflict notice layout boxes");
        expect(itemBox.x).toBeGreaterThanOrEqual(noticeBox.x);
        expect(itemBox.x + itemBox.width).toBeLessThanOrEqual(noticeBox.x + noticeBox.width);
        expect(itemBox.y).toBeGreaterThanOrEqual(noticeBox.y);
        expect(itemBox.y + itemBox.height).toBeLessThanOrEqual(noticeBox.y + noticeBox.height);
      }

      await dismiss.click();
      await notice.waitFor({ state: "detached" });
      await historyCard.waitFor();

      await page.setViewportSize({ width: 1440, height: 900 });
      await gateway.setSessionsListResponse(sessionsList(false));
      await page.reload();
      await page.locator(".chat-workspace-conflict-event").waitFor({ timeout: 10_000 });
      await sessionRow.getByText("Cloud conflict cleared", { exact: true }).waitFor();
      expect(await page.locator(".chat-workspace-conflict-notice").count()).toBe(0);
      expect(await sessionRow.locator(".session-row-badge--cloud").count()).toBe(0);
      expect(await page.locator(".chat-workspace-conflict-event").textContent()).toContain(
        conflict.stagedResultRef,
      );
    });
  });

  it.each([
    {
      customType: "cloud-workspace-recovery-failed",
      content:
        "Cloud workspace recovery attempt failed: snapshot verification failed. OpenClaw preserved the result and will retry.",
    },
    {
      customType: "run-failed-before-reply",
      content: "This turn did not run: Cloud worker is unavailable. Choose another runner.",
    },
  ])(
    "renders durable $customType notices from transcript history",
    async ({ customType, content }) => {
      await suite.withPage(pageOptions, async ({ page }) => {
        await openSession(page, [historyEvent(customType, content)]);
        const notice = page.locator(".chat-group.other").filter({ hasText: content });
        await notice.waitFor({ timeout: 10_000 });
        expect(await page.locator(".chat-group.assistant").count()).toBe(0);
        await page.reload();
        await notice.waitFor({ timeout: 10_000 });
        expect(await notice.count()).toBe(1);
        expect(await notice.locator(".chat-sender-name").textContent()).toBe("Error");
      });
    },
  );

  it.each(["failed", "reclaimed", "request"])(
    "exposes the full %s diagnostic with keyboard and clipboard access",
    async (failedState) => {
      await suite.withPage(
        { ...pageOptions, permissions: ["clipboard-read", "clipboard-write"] },
        async ({ page }) => {
          const gateway = await openSession(page, [
            {
              role: "assistant",
              content: [{ type: "text", text: "Remote work completed successfully." }],
              timestamp: Date.now() - 2_000,
            },
          ]);
          await page.getByText("Remote work completed successfully.").waitFor({ timeout: 10_000 });
          await expect.poll(() => page.getByRole("alert").allTextContents()).toEqual([]);

          if (failedState === "request") {
            await gateway.setMethodResponse("sessions.patch", {
              __mockError: { code: "UNAVAILABLE", message: workerFailureDiagnostic },
            });
            await page.locator(".chat-pane__session-title-button").click();
            const rename = page.locator(".chat-pane__session-title-input");
            await rename.fill("Rejected rename");
            await rename.press("Enter");
            await gateway.waitForRequest("sessions.patch");
          } else {
            await gateway.setSessionsListResponse(workerRecoverySessionsList(true, failedState));
            await page.reload();
          }
          const alert = page
            .getByRole("alert")
            .filter({ hasText: "provider reported lease destroyed" });
          await alert.waitFor({ timeout: 10_000 });
          expect(await alert.textContent()).toContain("provider reported lease destroyed");
          expect(await alert.textContent()).not.toContain("stale terminal worker failure");
          const summary = alert.locator("summary");
          const copy = alert.getByRole("button", { name: "Copy error", exact: true });
          const diagnostic = alert.locator("pre");
          const expected = `${failedState === "request" ? "" : "Runner failed: "}${workerFailureDiagnostic}`;
          expect(await summary.count()).toBe(1);
          expect(await diagnostic.isVisible()).toBe(false);
          for (const width of [1440, 320]) {
            await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
            if (width === 320) {
              // Viewport changes retire the desktop sidebar asynchronously.
              await expect
                .poll(() =>
                  page
                    .locator(".sidebar")
                    .evaluate(
                      (node) =>
                        !node.checkVisibility({ checkOpacity: true }) ||
                        node.getBoundingClientRect().right <= 0,
                    ),
                )
                .toBe(true);
            }
            await summary.press("Enter");
            await diagnostic.waitFor({ state: "visible" });
            expect(await diagnostic.textContent()).toBe(expected);
            expect(await alert.locator("img").count()).toBe(0);
            const bounds = await diagnostic.evaluate((node) => {
              const box = node.getBoundingClientRect();
              return {
                edges: [box.left, innerWidth - box.right, box.top, innerHeight - box.bottom],
                overflowX: node.scrollWidth - node.clientWidth,
                overflowY: node.scrollHeight - node.clientHeight,
              };
            });
            expect(Math.min(...bounds.edges)).toBeGreaterThanOrEqual(0);
            expect(bounds.overflowX).toBeLessThanOrEqual(1);
            expect(bounds.overflowY).toBeGreaterThan(0);
            const compact = width === 320 && failedState !== "request";
            const firstAction = compact
              ? alert.getByRole("button", { name: "Refresh", exact: true })
              : copy;
            await page.keyboard.press("Tab");
            expect(await firstAction.evaluate((node) => node === document.activeElement)).toBe(
              true,
            );
            await page.keyboard.press("Tab");
            expect(await diagnostic.evaluate((node) => node === document.activeElement)).toBe(true);
            if (compact) {
              await page.keyboard.press("Tab");
              expect(await copy.evaluate((node) => node === document.activeElement)).toBe(true);
              await page.keyboard.press("Shift+Tab");
            }
            await page.keyboard.press("PageDown");
            await expect
              .poll(() => diagnostic.evaluate((node) => node.scrollTop))
              .toBeGreaterThan(0);
            expect(
              await diagnostic.evaluate((node) => {
                const range = document.createRange();
                range.selectNodeContents(node);
                const selection = window.getSelection();
                selection?.removeAllRanges();
                selection?.addRange(range);
                return selection?.toString();
              }),
            ).toBe(expected);
            await copy.press("Enter");
            await expect
              .poll(() => page.evaluate(() => navigator.clipboard.readText()))
              .toBe(expected);
            await diagnostic.evaluate((node) => {
              window.getSelection()?.removeAllRanges();
              node.scrollTop = node.scrollHeight;
            });
            await summary.press("Space");
            await expect.poll(() => diagnostic.isVisible()).toBe(false);
            await alert
              .getByRole("button", { name: "Copy error", exact: true, includeHidden: true })
              .waitFor({ state: "attached" });
          }
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          if (failedState === "request") {
            await alert.getByRole("button", { name: "Dismiss error" }).click();
            await alert.waitFor({ state: "detached" });
          }
        },
      );
    },
  );
});
