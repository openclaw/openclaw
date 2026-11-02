import { expect, it } from "vitest";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import { identityFixture } from "./session-identity.test-support.ts";
import {
  createSessionManagementE2eSuite,
  requireRecord,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it.each(["sessions", "sidebar", "header"] as const)(
    "keeps a replacement session unchanged after a stale %s rename",
    async (surface) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const { original, replacement, gateway, row, replace } = await identityFixture(
          page,
          suite.server.baseUrl,
          surface,
          "rename",
        );
        const openRename = async () => {
          if (surface === "header") {
            await page.locator(".chat-pane__session-title-button").click();
          } else {
            await row.hover();
            await row.click({ button: "right" });
            await page.getByRole("menuitem", { name: "Rename…" }).click();
          }
        };
        await openRename();
        const input = page.locator(
          surface === "header"
            ? ".chat-pane__session-title-input"
            : 'openclaw-modal-dialog[label="Rename session"] input',
        );
        await expect.poll(() => input.inputValue()).toBe(original.label);
        await input.fill("Stale rename");

        await replace();
        await input.press("Enter");
        const request = await waitForPatch(gateway, (params) => params.label === "Stale rename");
        const params = requireRecord(request.params);
        // Replay the Gateway's existing metadata CAS contract, covered by
        // server.sessions.patch-expected-identity.test.ts, without a new mock seam.
        if (params.expectedSessionId && params.expectedSessionId !== replacement.sessionId) {
          await gateway.rejectDeferred("sessions.patch", {
            code: "INVALID_REQUEST",
            message: `Session ${original.key} changed before patch. Retry.`,
            details: { reason: "session-changed" },
          });
        } else {
          await gateway.resolveDeferred("sessions.patch");
        }
        if (surface !== "header") {
          const dialog = page.getByRole("dialog", { name: "Rename session", exact: true });
          await expect
            .poll(() => dialog.getByRole("alert").textContent())
            .toContain("changed before patch. Retry.");
          expect(await input.inputValue()).toBe("Stale rename");
          await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        }
        await input.waitFor({ state: "detached" });
        await expect
          .poll(() => page.getByText(/changed before patch\. Retry\./).count())
          .toBeGreaterThan(0);
        expect(params).toMatchObject({
          key: original.key,
          expectedSessionId: original.sessionId,
          label: "Stale rename",
        });
        expect(await row.textContent()).toContain(replacement.label);
        expect(await page.getByText("Stale rename", { exact: true }).count()).toBe(0);

        await openRename();
        await expect.poll(() => input.inputValue()).toBe(replacement.label);
        await input.fill("Fresh rename");
        await input.press("Enter");
        const fresh = await waitForPatch(gateway, (next) => next.label === "Fresh rename");
        expect(fresh.params).toMatchObject({
          key: original.key,
          expectedSessionId: replacement.sessionId,
          label: "Fresh rename",
        });
        await expect.poll(() => row.textContent()).toContain("Fresh rename");
      });
    },
  );
});
