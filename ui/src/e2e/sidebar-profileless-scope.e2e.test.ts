import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { ApplicationRuntime } from "../app/bootstrap.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Personal navigation identity resolution" });

suite.define(() => {
  it("keeps unresolved Mine private, falls back for a profileless connection, and restores Mine after identification", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 800 }, locale: "en-US" },
      async ({ page }) => {
        const mine = "agent:main:planning";
        const other = "agent:main:research";
        const gateway = await installMockGateway(page, {
          heldMethods: ["users.self"],
          featureMethods: [...defaultControlUiFeatureMethods, "users.prefs.get", "users.prefs.set"],
          agentModel: "gpt-5-mini",
          sessions: [
            {
              key: mine,
              label: "Weekly planning",
              owner: { actor: { type: "human", id: "alex", label: "Alex" } },
            },
            {
              key: other,
              label: "Research notes",
              owner: { actor: { type: "human", id: "sam", label: "Sam" } },
            },
          ],
          methodResponses: {
            "users.prefs.get": {
              status: "ok",
              entries: {
                "ui.sidebarEntries": [],
                "ui.navigationScope": "mine",
                "new-session.migration.v1": true,
              },
            },
          },
        });
        await page.goto(suite.server.baseUrl + "new");
        await gateway.waitForRequest("users.self");
        const sidebar = page.locator("openclaw-app-sidebar");
        const rows = sidebar.locator(".sidebar-session-content .sidebar-recent-session");
        expect(await rows.count()).toBe(0);
        expect(
          await sidebar
            .getByRole("button", { name: "Mine", exact: true })
            .getAttribute("aria-pressed"),
        ).toBe("true");
        await gateway.rejectDeferred("users.self", {
          code: "FORBIDDEN",
          message: "No authenticated profile",
        });
        await expect
          .poll(() =>
            sidebar.getByRole("button", { name: "All", exact: true }).getAttribute("aria-pressed"),
          )
          .toBe("true");
        await expect.poll(() => rows.count()).toBe(2);
        expect(await gateway.getRequests("users.prefs.set")).toEqual([]);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".shell"),
            [sidebar, page.locator(".new-session-page")],
            { animations: "disabled" },
          );
          await writeFile(
            path.join(suite.artifactDir, "profileless-accessible-sessions.png"),
            frame.png,
          );
        }
        const instanceId = await page
          .locator("openclaw-app")
          .evaluate(
            (element: HTMLElement & { runtime: ApplicationRuntime }) =>
              element.runtime.context.gateway.snapshot.client?.instanceId,
          );
        expect(instanceId).toBeTruthy();
        await gateway.emitGatewayEvent("presence", {
          presence: [
            {
              instanceId,
              user: { id: "alex", identity: { type: "profile", id: "alex" }, name: "Alex" },
            },
          ],
        });
        await expect
          .poll(() =>
            sidebar.getByRole("button", { name: "Mine", exact: true }).getAttribute("aria-pressed"),
          )
          .toBe("true");
        await expect.poll(() => rows.count()).toBe(1);
        expect(await rows.first().getAttribute("data-session-key")).toBe(mine);
        expect(await gateway.getRequests("users.prefs.set")).toEqual([]);
      },
    );
  });
});
