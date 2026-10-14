import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
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
import { chooseSidebarOwner } from "./sidebar-session-menu.test-support.ts";

const suite = createControlUiE2eSuite({ name: "New session sidebar visibility" });
suite.define(() => {
  it("clears accepted text and attachments while the preview route is still loading", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        deferredMethods: ["sessions.create"],
      });
      await page.goto(suite.server.baseUrl + "new?agent=main");
      const composer = page.locator(".new-session-page__message");
      await composer.fill("Investigate sidebar updates");
      await page.locator(".agent-chat__file-input").setInputFiles({
        name: "sidebar-notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Synthetic reproduction notes"),
      });
      await waitForCommittedNewSessionDraft(page, "Investigate sidebar updates", [
        "sidebar-notes.txt",
      ]);
      const held = await holdModuleResponse(
        page,
        controlUiE2eBuiltModuleRequest("ui/src/pages/chat/route-entry.ts"),
      );
      try {
        await composer.press("Enter");
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
      const viewer = {
        type: "human" as const,
        id: "profile-ada",
        label: "Ada",
        identity: { type: "profile" as const, id: "profile-ada" },
      };
      const old = {
        key: "agent:main:planning",
        sessionId: "planning",
        kind: "direct",
        label: "Weekly planning",
        updatedAt: 1,
        owner: { actor: viewer },
      };
      const created = {
        key: "agent:main:sidebar-proof",
        sessionId: "sidebar-proof",
        kind: "direct",
        label: "Investigate sidebar updates",
        updatedAt: 2,
        owner: { actor: viewer },
        hasActiveRun: true,
        status: "running",
      };
      const response = (sessions: unknown[]) => ({
        sessions,
        ts: 2,
        path: "",
        count: sessions.length,
        hasMore: false,
        nextOffset: null,
        defaults: { model: null, modelProvider: null, contextTokens: null },
        owners: [
          viewer,
          {
            type: "human",
            id: "profile-bob",
            label: "Bob",
            identity: { type: "profile", id: "profile-bob" },
          },
        ],
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
      await page.locator('.sidebar-recent-session[data-session-key="' + old.key + '"]').waitFor();
      await chooseSidebarOwner(page, "involving-me");
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.list")).some(
            (request) => (request.params as { involvingMe?: boolean }).involvingMe === true,
          ),
        )
        .toBe(true);
      const composer = page.locator(".new-session-page__message");
      await composer.fill("Investigate sidebar updates");
      await composer.press("Enter");
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
      const row = page.locator('.sidebar-recent-session[data-session-key="' + created.key + '"]');
      const artifactParent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      if (artifactParent) {
        const directory = createControlUiE2eArtifactDir("new-session-sidebar", artifactParent);
        const png = await takeControlUiViewportScreenshot(page, page.locator("body"), [
          page.locator(".sidebar"),
        ]);
        await writeFile(path.join(directory, "accepted-running-session.png"), png);
      }
      await expect.poll(() => row.count()).toBe(1);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
    });
  });
});
