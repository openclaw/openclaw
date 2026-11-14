import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { expectRequestCountStable } from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import * as ui from "./session-management.compact.test-support.ts";
import * as support from "./session-management.test-support.ts";

const suite = support.createSessionManagementE2eSuite();

suite.define(() => {
  it.each(["sidebar", "list"] as const)(
    "warns without stopping automations when deleting from the %s",
    (surface) =>
      suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const main = sessionRow("agent:main:main", "Main", 1);
        const target = sessionRow("agent:main:backup", "Backup maintenance", 2, {
          hasAutomation: true,
        });
        const gateway = await ui.installSessionRows(page, [main, target], {
          sessionKey: main.key,
          methodResponses: {
            "sessions.delete": { ok: true, deleted: true },
            "cron.list": cronListResponseFixture({
              jobs: [
                {
                  id: "nightly-backup",
                  name: "Nightly backup",
                  enabled: true,
                  createdAtMs: 1,
                  updatedAtMs: 1,
                  schedule: { kind: "every", everyMs: 86_400_000 },
                  sessionTarget: "isolated",
                  wakeMode: "now",
                  payload: { kind: "command", argv: ["echo", "synthetic backup"] },
                  state: {},
                },
              ],
              snapshotRevision: "delete-automation-1",
              total: 1,
              limit: 10,
              offset: 0,
              nextOffset: null,
              hasMore: false,
            }),
          },
        });
        await page.goto(
          surface === "list"
            ? suite.server.baseUrl + "sessions"
            : support.controlUiSessionUrl(suite.server.baseUrl, main.key),
        );
        const row =
          surface === "list"
            ? page.locator(".session-data-row").filter({ hasText: target.label })
            : page.locator('.sidebar-recent-session[data-session-key="' + target.key + '"]');
        const openDelete = async () => {
          await ui.visible(row);
          if (surface === "sidebar") {
            await row.click({ button: "right" });
          } else {
            await ui.button(row, "Open session menu", false).click();
          }
          await ui.menuItem(page, "Advanced").click();
          await support.activateSelfRemovingControl(
            ui.menuItem(page.locator("openclaw-session-menu"), "Delete…"),
          );
          const dialog = await support.waitForConfirmModal(page);
          await dialog.getByText("Nightly backup (nightly-backup)").waitFor();
          return dialog;
        };
        let dialog = await openDelete();
        const panel = dialog.locator(".oc-dialog");
        const frame = await takeControlUiScreenshotFrame(page, panel, [panel], {
          elements: [panel],
          animations: "disabled",
        });
        await writeFile(
          path.join(suite.artifactDir, "delete-automation-" + surface + ".png"),
          frame.elements[0]!.png,
        );
        expect
          .soft(await dialog.textContent())
          .toContain(
            'Automations linked to "Backup maintenance" may keep running after deletion. Disable or remove them separately.',
          );
        await ui.button(dialog, "Cancel").click();
        await dialog.waitFor({ state: "detached" });
        await expectRequestCountStable(gateway, "sessions.delete", 0);
        dialog = await openDelete();
        await gateway.setSessionsListResponse(support.sessionsListResponse([main]));
        await ui.button(dialog, "Delete anyway").click();
        expect(await gateway.waitForRequest("sessions.delete")).toMatchObject({
          params: { key: target.key, expectedSessionId: target.sessionId, deleteTranscript: true },
        });
        await row.waitFor({ state: "detached" });
        await expectRequestCountStable(gateway, "sessions.delete", 1);
        await ui.expectNoRequests(gateway, "cron.update", "cron.remove", "cron.run");
      }),
  );
});
