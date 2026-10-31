import { expect, it } from "vitest";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import { identityFixture } from "./session-identity.test-support.ts";
import {
  activateSelfRemovingControl,
  createSessionManagementE2eSuite,
  openSessionMenuSubmenu,
  requireRecord,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it.each(["sessions", "sidebar", "selection", "header"] as const)(
    "keeps a replacement unchanged during a pending %s new-group assignment",
    async (surface) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const { original, survivor, replacement, gateway, row, batch, method, replace } =
          await identityFixture(page, suite.server.baseUrl, surface, "group");
        const group = "Selected work";
        if (batch) {
          for (const key of [original.key, survivor.key]) {
            await page
              .locator(`[data-session-key="${key}"] .sidebar-recent-session__link`)
              .click({ modifiers: ["Alt"] });
          }
          await expect
            .poll(() => page.locator(".sidebar-recent-session--selected").count())
            .toBe(2);
        }
        if (surface === "header") {
          await page.locator(".chat-header-session-menu__trigger").click();
        } else {
          await row.hover();
          await row.click({ button: "right" });
        }
        await openSessionMenuSubmenu(page, batch ? "Move 2 to group" : "Move to group");
        await activateSelfRemovingControl(page.getByRole("menuitem", { name: "New group" }));
        const input = page.getByLabel("New group name");
        await input.fill(group);
        await input.press("Enter");
        await gateway.waitForRequest("sessions.groups.put");

        // Deletion/recreation changes the durable identity, unlike ordinary reset.
        await replace();
        await gateway.resolveDeferred("sessions.groups.put");
        const request = await gateway.waitForRequest(method);
        const params = requireRecord(request.params);
        const targets =
          batch && Array.isArray(params.targets) ? params.targets.map(requireRecord) : [params];
        const acceptedKeys: string[] = [];
        // Replay the existing Gateway CAS contract, not the UI's intended result.
        // The generic mock otherwise accepts every metadata write unconditionally.
        const outcomes = targets.map((target) => {
          const current = target.key === original.key ? replacement : survivor;
          if (target.expectedSessionId && target.expectedSessionId !== current.sessionId) {
            return {
              ok: false,
              key: target.key,
              agentId: target.agentId,
              error: {
                code: "INVALID_REQUEST",
                message: `Session ${String(target.key)} changed before patch. Retry.`,
                details: { reason: "session-changed" },
              },
            };
          }
          acceptedKeys.push(String(target.key));
          return { ok: true, key: target.key, agentId: target.agentId };
        });
        if (batch) {
          await gateway.setMethodResponse(method, { outcomes });
          await gateway.resolveDeferred(method);
        } else if (outcomes[0]?.error) {
          await gateway.rejectDeferred(method, outcomes[0].error);
        } else {
          await gateway.resolveDeferred(method);
        }
        const failure =
          surface === "header"
            ? page.getByText(/changed before patch\. Retry\./).first()
            : page.locator('openclaw-modal-dialog [role="alert"]');
        expect(acceptedKeys).not.toContain(original.key);
        await failure.waitFor({ state: "visible" });
        expect(targets.find((target) => target.key === original.key)).toMatchObject({
          expectedSessionId: original.sessionId,
        });
        expect(await failure.textContent()).toContain("changed before patch. Retry.");
        if (batch) {
          expect(acceptedKeys).toEqual([survivor.key]);
          await page
            .locator(
              `[data-session-section="category:${group}"] [data-session-key="${survivor.key}"]`,
            )
            .waitFor({ state: "visible" });
        }
        expect(
          await page
            .locator(
              `[data-session-section="category:${group}"] [data-session-key="${original.key}"]`,
            )
            .count(),
        ).toBe(0);
        expect(await input.inputValue()).toBe(group);
        expect(await input.isEnabled()).toBe(true);
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await input.waitFor({ state: "detached" });
      });
    },
  );
});
