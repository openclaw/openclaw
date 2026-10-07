import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
  waitForConfirmModal,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite(true);

suite.define(() => {
  it("treats a pending-deletion child as inside the server window on a fresh mounted read", async () => {
    const mainKey = "agent:main:main";
    const parentKey = "agent:main:parent";
    const doomedKey = "agent:worker:doomed";
    const survivorKey = "agent:worker:survivor";
    // The server never learns about the deletion in time: both children stay in
    // its window, so the delivered projection is one visible row against
    // totalCount 2. Completeness must count the overlay-hidden row.
    const childRows = () =>
      sessionsListResponse([
        sessionRow(doomedKey, "Doomed child", 40, { spawnedBy: parentKey }),
        sessionRow(survivorKey, "Surviving child", 35, { spawnedBy: parentKey }),
      ]);
    const rootRows = () =>
      sessionsListResponse([
        sessionRow(mainKey, "Main", 30),
        sessionRow(parentKey, "Parent task", 20, {
          childSessions: [doomedKey, survivorKey],
        }),
      ]);
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.delete": { ok: true, deleted: true },
        "sessions.list": {
          cases: [
            { match: { spawnedBy: parentKey }, response: childRows() },
            { response: rootRows() },
          ],
        },
      },
      sessionKey: mainKey,
    });
    const childReads = async () =>
      (await gateway.getRequests("sessions.list")).filter(
        (request) =>
          typeof request.params === "object" &&
          request.params !== null &&
          "spawnedBy" in request.params &&
          request.params.spawnedBy === parentKey,
      ).length;
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, mainKey));
      const toggle = page.locator(`[data-child-session-toggle="${parentKey}"]`);
      const parent = page.locator(`[data-session-key="${parentKey}"]`);
      await parent.waitFor({ state: "visible", timeout: 10_000 });
      await toggle.click();
      const doomed = page.locator(`[data-session-key="${doomedKey}"]`);
      const survivor = page.locator(`[data-session-key="${survivorKey}"]`);
      await doomed.waitFor({ state: "visible" });
      await survivor.waitFor({ state: "visible" });
      const error = page.locator(`[data-child-session-error="${parentKey}"]`);
      expect(await error.count()).toBe(0);

      await gateway.deferNext("sessions.delete");
      await doomed.hover();
      await doomed.click({ button: "right" });
      await page
        .locator("openclaw-session-menu")
        .getByRole("menuitem", { name: "Delete…" })
        .click();
      const confirmation = await waitForConfirmModal(page);
      await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
      await gateway.waitForRequest("sessions.delete");

      // Collapsing retires the mounted child read; re-expanding starts a fresh
      // one against the still-two-row server window while the deletion overlay
      // stays pending.
      const readsBeforeRefresh = await childReads();
      // The pending-deletion row renders a layer that intercepts hit tests over
      // the toggle, so activate the same @click handler directly.
      const activateToggle = () => toggle.evaluate((element) => (element as HTMLElement).click());
      await activateToggle();
      await survivor.waitFor({ state: "detached" });
      // Hold the fresh child read so its response carries a label the cached
      // rows never had: the settled assertions below can only run once that
      // read has published, which is the child-load owner's completion boundary.
      await gateway.deferNext("sessions.list", { spawnedBy: parentKey });
      await activateToggle();
      await expect.poll(childReads, { timeout: 10_000 }).toBeGreaterThan(readsBeforeRefresh);
      await gateway.resolveDeferred(
        "sessions.list",
        sessionsListResponse([
          sessionRow(doomedKey, "Doomed child", 40, { spawnedBy: parentKey }),
          sessionRow(survivorKey, "Surviving child refreshed", 36, { spawnedBy: parentKey }),
        ]),
      );
      await expect
        .poll(async () => ((await survivor.count()) > 0 ? await survivor.textContent() : ""), {
          timeout: 10_000,
        })
        .toContain("Surviving child refreshed");

      if ((await error.count()) > 0) {
        console.log(
          "FALSE-ERROR-STATE",
          JSON.stringify({
            errorText: await error.textContent(),
            reads: await childReads(),
            deletes: (await gateway.getRequests("sessions.delete")).length,
            doomed: await doomed.count(),
            survivor: await survivor.count(),
          }),
        );
        await captureUiProof(suite, page, "child-session-deletion-overlay-false-error.png");
      }
      expect(await error.count()).toBe(0);
      expect(await doomed.count()).toBe(0);
      expect(await survivor.count()).toBe(1);
      await captureUiProof(suite, page, "child-session-deletion-overlay-recovered.png");
    } finally {
      try {
        await gateway.resolveDeferred("sessions.delete", { ok: true, deleted: true });
      } catch {
        // The deferred response was already consumed by a mutation retry.
      }
      await context.close();
    }
  });
});
