import { expect, it } from "vitest";
import { pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";
import {
  installMockGateway,
  waitForCommittedChatRoute,
  waitForCommittedNewSessionDraft,
} from "./new-session-page.test-support.ts";
import { ownerRoster, sessionPerson } from "./session-ownership-fixtures.test-support.ts";
import { chooseSidebarOwner } from "./sidebar-session-menu.test-support.ts";

const suite = createControlUiE2eSuite({ name: "New session sidebar visibility" });
const prompt = "Investigate sidebar updates";
suite.define(() => {
  it("clears accepted text and attachments while the preview route is still loading", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        deferredMethods: ["sessions.create"],
      });
      await page.goto(suite.server.baseUrl + "new?agent=main");
      const message = page.locator(".new-session-page__message");
      await message.fill(prompt);
      await page.locator(".agent-chat__file-input").setInputFiles({
        name: "sidebar-notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Synthetic reproduction notes"),
      });
      await waitForCommittedNewSessionDraft(page, prompt, ["sidebar-notes.txt"]);
      const held = await holdModuleResponse(
        page,
        controlUiE2eBuiltModuleRequest("ui/src/pages/chat/route-entry.ts"),
      );
      try {
        await message.press("Enter");
        await gateway.waitForRequest("sessions.create");
        await held.request;
        await gateway.resolveDeferred("sessions.create");
        // The accepted draft must retire while chat's actual lazy route is held.
        await waitForCommittedNewSessionDraft(page, null, 0);
      } finally {
        held.release();
      }
      await waitForCommittedChatRoute(page);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
    });
  });
  it("shows an accepted running session under Involving me before event refresh timers or run completion", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const viewer = sessionPerson("profile-ada", "Ada");
      const old = {
        key: "agent:main:planning",
        sessionId: "planning",
        kind: "direct",
        label: "Weekly planning",
        updatedAt: 1,
        owner: { actor: viewer },
      };
      const created = {
        ...old,
        key: "agent:main:sidebar-proof",
        sessionId: "sidebar-proof",
        label: prompt,
        updatedAt: 2,
        hasActiveRun: true,
        status: "running",
      };
      const response = (sessions: unknown[]) => ({
        ...ownerRoster(sessions, [viewer, sessionPerson("profile-bob", "Bob")]),
        ts: 2,
        hasMore: false,
        nextOffset: null,
      });
      const gateway = await installMockGateway(page, {
        sessionKey: old.key,
        sessions: [old],
        presenceUsers: [{ self: true, id: viewer.id, name: viewer.label }],
        deferredMethods: ["sessions.create"],
        methodResponses: {
          "sessions.list": response([old]),
          "sessions.create": {
            key: created.key,
            entry: created,
            runStarted: true,
            runId: "sidebar-proof-run",
          },
        },
      });
      await page.goto(suite.server.baseUrl + "new?agent=main");
      await page.locator(`.sidebar-recent-session[data-session-key="${old.key}"]`).waitFor();
      await chooseSidebarOwner(page, "involving-me");
      await gateway.waitForRequest("sessions.list", { match: { involvingMe: true } });
      const message = page.locator(".new-session-page__message");
      await message.fill(prompt);
      await message.press("Enter");
      await gateway.waitForRequest("sessions.create");
      await page.clock.install();
      await pauseVirtualClock(page);
      await gateway.setMethodResponse("sessions.list", response([created, old]));
      await gateway.resolveDeferred("sessions.create");
      await page.clock.runFor(200);
      await waitForCommittedChatRoute(page);
      // Only presentation frames may elapse: no collection window, cooldown,
      // manual refresh, or terminal message may make the new row appear.
      await page.clock.runFor(0);
      const row = page.locator(`.sidebar-recent-session[data-session-key="${created.key}"]`);
      await expect.poll(() => row.count()).toBe(1);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
    });
  });
});
