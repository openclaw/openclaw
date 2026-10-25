import { expect, it, onTestFinished } from "vitest";
import { persistColdLoadWarmState } from "../../../scripts/lib/control-ui-bench-warm-state.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails, openChatDetails } from "./chat-details.test-support.ts";
import { nextPaint } from "./chat-session-diff.test-support.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Details loading" });

suite.define(() => {
  it.each(["ready", "failed"] as const)(
    "keeps warm Details blank until its sections settle (roster=%s)",
    async (roster) => {
      await suite.withPage({ viewport: { width: 1700, height: 900 } }, async ({ page }) => {
        const sessionKey = "agent:main:00000000-0000-4000-8000-00000000d201";
        const text = "The cached transcript is ready before Details.";
        const children = ["inspect", "verify"].map((name) => ({
          key: `agent:main:subagent:${name}`,
          sessionId: name,
          kind: "direct" as const,
          spawnedBy: sessionKey,
          label: name,
          status: "done" as const,
        }));
        const childQuery = { spawnedBy: sessionKey };
        const gateway = await installMockGateway(page, {
          featureMethods: [...defaultControlUiFeatureMethods, "progressCard.get"],
          deferredRequests: [{ method: "sessions.list", match: childQuery }],
          sessions: [
            {
              key: sessionKey,
              sessionId: "00000000-0000-4000-8000-00000000d201",
              kind: "direct",
              label: "Inspect reload",
              worktree: {
                id: "details-worktree",
                branch: "feature/details",
                repoRoot: "/workspace/details",
              },
            },
            ...children,
          ],
          methodResponses: {
            "progressCard.get": {
              card: {
                sessionKey,
                revision: 1,
                updatedAt: 1,
                steps: [{ step: "Keep progress stable", status: "in_progress" }],
              },
            },
          },
          historyMessages: [
            { role: "assistant", content: text, __openclaw: { id: "details-cached", seq: 1 } },
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await gateway.waitForRequest("sessions.list", { match: childQuery });
        await gateway.resolveDeferred("sessions.list", undefined, { match: childQuery });
        const subagents = page.locator('.chat-details [data-details-group="subagents"]');
        await subagents.getByText("verify", { exact: true }).waitFor();
        const progress = page.locator(".chat-details openclaw-chat-details-progress");
        await progress.getByRole("listitem", { name: "Keep progress stable, paused" }).waitFor();
        await nextPaint(page);
        const readOffset = (element: Element) =>
          element.getBoundingClientRect().top -
          element.closest(".chat-details")!.getBoundingClientRect().top;
        const settledOffset = await progress.evaluate(readOffset);
        await page.locator('aside.sidebar[data-snapshot-saved="true"]').waitFor();
        const warmInput: Parameters<typeof persistColdLoadWarmState>[0] = {
          sessionKey,
          sidebarView: "sessions",
        };
        const warm = await page.evaluate(persistColdLoadWarmState, warmInput);
        expect(warm.messages).toBe(1);

        const module = await holdModuleResponse(
          page,
          controlUiE2eBuiltModuleRequest("ui/src/pages/chat/components/chat-details-session.tsx"),
        );
        onTestFinished(module.release);
        await page.reload();
        await gateway.waitForRequest("sessions.list", { match: childQuery });
        await page.locator(".chat-thread").getByText(text, { exact: true }).waitFor();
        const details = page.locator(".chat-details[data-open]");
        await details.waitFor();
        const moduleUrl = await module.request;
        expect(await details.locator(".chat-details-session").count()).toBe(0);
        expect(await details.locator("openclaw-panel-loading-skeleton").count()).toBe(0);
        const width = await details.evaluate((panel) => panel.getBoundingClientRect().width);
        expect(width).toBe(300);

        module.release();
        await page.evaluate(`import(${JSON.stringify(moduleUrl)}).then(() => undefined)`);
        await details.locator(".chat-details-session").waitFor({ state: "attached" });
        await nextPaint(page);
        expect(await subagents.count()).toBe(0);
        expect(await progress.isVisible()).toBe(false);
        if (roster === "failed") {
          await gateway.rejectDeferred(
            "sessions.list",
            { code: "INVALID_REQUEST", message: "Child roster unavailable" },
            { match: childQuery },
          );
        } else {
          await gateway.resolveDeferred("sessions.list", undefined, { match: childQuery });
          await subagents.getByText("verify", { exact: true }).waitFor();
        }
        await progress.getByRole("listitem", { name: "Keep progress stable, paused" }).waitFor();
        await nextPaint(page);
        if (roster === "ready") {
          expect(await progress.evaluate(readOffset)).toBeCloseTo(settledOffset, 0);
        } else {
          expect(await subagents.count()).toBe(0);
        }
        expect(await details.locator("openclaw-panel-loading-skeleton").count()).toBe(0);
        expect(await details.evaluate((panel) => panel.getBoundingClientRect().width)).toBe(width);
        expect(module.requests()).toBe(1);
      });
    },
  );

  it("shows a skeleton on first open and settles after closing and reopening a pending Details view", async () => {
    await suite.withPage(
      { viewport: { width: 390, height: 844 }, hasTouch: true },
      async ({ page }) => {
        const module = await holdModuleResponse(
          page,
          controlUiE2eBuiltModuleRequest("ui/src/pages/chat/chat-details-mobile-host-content.tsx"),
        );
        onTestFinished(module.release);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await installMockGateway(page, {
          sessions: [
            {
              key: "agent:main:main",
              sessionId: "loading-details",
              kind: "direct",
              label: "Review release notes",
            },
          ],
        });
        await page.goto(suite.server.baseUrl + "chat");
        await page.locator(".mobile-header__title").waitFor();
        expect(module.requests()).toBe(0);
        const details = await openChatDetails(page);
        await module.request;
        const loading = details.getByRole("status", { name: "Loading…", exact: true });
        await loading.waitFor();
        expect(await loading.getByText("Loading…", { exact: true }).count()).toBe(0);
        expect(await loading.getAttribute("aria-busy")).toBe("true");
        await closeChatDetails(page);
        module.release();
        await page.locator(".chat-mobile-host").waitFor({ state: "hidden" });
        const reopened = await openChatDetails(page);
        await reopened.locator(".chat-details-mobile-root").waitFor();
        expect(await reopened.getByRole("status", { name: "Loading…", exact: true }).count()).toBe(
          0,
        );
        expect(module.requests()).toBe(1);
        expect(errors).toEqual([]);
      },
    );
  });
});
