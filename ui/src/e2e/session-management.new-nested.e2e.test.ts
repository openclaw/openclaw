import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import * as ui from "./session-management.compact.test-support.ts";
import * as support from "./session-management.test-support.ts";

const suite = support.createSessionManagementE2eSuite(true);
const parentKey = "agent:main:planning";
const childKey = "agent:main:planning-child";
const parent = sessionRow(parentKey, "Project planning", Date.parse("2026-07-01T16:00:00Z"));
const child = sessionRow(childKey, "New nested session", Date.parse("2026-07-01T16:01:00Z"), {
  spawnedBy: parentKey,
});

suite.define(() => {
  it("creates a persistent empty nested session from the sidebar context menu", () =>
    ui.withSessionPage(suite, async (page) => {
      const gateway = await ui.installSessionRows(page, [parent], {
        sessionKey: parentKey,
        methodResponses: {
          "sessions.create": { key: childKey, entry: child },
        },
      });
      await page.goto(support.controlUiSessionUrl(suite.server.baseUrl, parentKey));
      const row = page.locator('[data-session-key="' + parentKey + '"]');
      await row.waitFor({ state: "visible" });
      await row.hover();
      await row.click({ button: "right" });
      await page
        .getByRole("menuitem", { name: "Pin session", exact: true })
        .waitFor({ state: "visible", timeout: 10_000 });
      const action = page.getByRole("menuitem", { name: "New Nested Session", exact: true });
      if (process.env.OPENCLAW_CAPTURE_NESTED_PROOF) {
        const proofDir = fileURLToPath(
          new URL("../../../.openclaw/tmp/nested-session-proof/", import.meta.url),
        );
        await mkdir(proofDir, { recursive: true });
        await page.screenshot({
          path: path.join(proofDir, process.env.OPENCLAW_CAPTURE_NESTED_PROOF + "-menu.png"),
        });
      }
      await action.waitFor({ state: "visible", timeout: 5_000 });
      await gateway.setMethodResponse(
        "sessions.list",
        support.sessionsListResponse([
          { ...parent, childSessions: [childKey], childSessionCount: 1 },
          child,
        ]),
      );
      await gateway.deferNext("sessions.create");
      await action.click();
      const pending = page.getByRole("menuitem", { name: "Creating nested session…", exact: true });
      await pending.waitFor({ state: "visible" });
      expect(await pending.getAttribute("aria-disabled")).toBe("true");
      await expect.poll(async () => (await gateway.getRequests("sessions.create")).length).toBe(1);
      await gateway.resolveDeferred("sessions.create");
      await ui.expectSessionPath(page, childKey);
      expect(await gateway.getRequests("sessions.create")).toMatchObject([
        { params: { parentSessionKey: parentKey, agentId: "main" } },
      ]);
      const requests = await gateway.getRequests("sessions.create");
      expect(requests[0]?.params).not.toHaveProperty("fork");
      expect(requests[0]?.params).not.toHaveProperty("message");
      await ui.expectNoRequests(gateway, "agent", "chat.send", "sessions.spawn");
      await page.locator('[data-session-key="' + childKey + '"]').waitFor({ state: "visible" });
      await page
        .getByRole("menuitem", { name: "New Nested Session", exact: true })
        .waitFor({ state: "hidden" });
      if (process.env.OPENCLAW_CAPTURE_NESTED_PROOF) {
        await page.screenshot({
          path: fileURLToPath(
            new URL(
              "../../../.openclaw/tmp/nested-session-proof/after-created.png",
              import.meta.url,
            ),
          ),
        });
      }
    }));

  it("shows a disabled action without parent write permission", () =>
    ui.withSessionPage(suite, async (page) => {
      const gateway = await ui.installSessionRows(page, [parent], {
        sessionKey: parentKey,
        operatorScopes: ["operator.read"],
      });
      await page.goto(support.controlUiSessionUrl(suite.server.baseUrl, parentKey));
      const row = page.locator('[data-session-key="' + parentKey + '"]');
      await row.waitFor({ state: "visible" });
      await row.click({ button: "right" });
      const action = page.getByRole("menuitem", { name: "New Nested Session", exact: true });
      await action.waitFor({ state: "visible" });
      expect(await action.getAttribute("aria-disabled")).toBe("true");
      expect(await action.getAttribute("title")).toBeTruthy();
      await ui.expectNoRequests(gateway, "sessions.create", "agent", "chat.send");
    }));

  it("reports a rejected create and keeps the parent conversation open", () =>
    ui.withSessionPage(suite, async (page) => {
      const gateway = await ui.installSessionRows(page, [parent], { sessionKey: parentKey });
      await page.goto(support.controlUiSessionUrl(suite.server.baseUrl, parentKey));
      const row = page.locator('[data-session-key="' + parentKey + '"]');
      await row.waitFor({ state: "visible" });
      await row.click({ button: "right" });
      const action = page.getByRole("menuitem", { name: "New Nested Session", exact: true });
      await action.waitFor({ state: "visible" });
      await gateway.deferNext("sessions.create");
      await action.click();
      await page
        .getByRole("menuitem", { name: "Creating nested session…", exact: true })
        .waitFor({ state: "visible" });
      await expect.poll(async () => (await gateway.getRequests("sessions.create")).length).toBe(1);
      await gateway.rejectDeferred("sessions.create", { message: "Parent is no longer available" });
      await page
        .getByText("Parent is no longer available", { exact: true })
        .waitFor({ state: "visible" });
      await ui.expectSessionPath(page, parentKey);
      await action.waitFor({ state: "hidden" });
      await row.click({ button: "right" });
      await action.waitFor({ state: "visible" });
      expect(await action.getAttribute("aria-disabled")).not.toBe("true");
      await ui.expectNoRequests(gateway, "agent", "chat.send", "sessions.spawn");
    }));
});
