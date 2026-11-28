import type { CronUpdateParams } from "@openclaw/gateway-protocol";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import {
  cronJob,
  cronList,
  cronRuns,
  cronSidebarFeatureMethods,
  editAutomation,
  openAutomation,
} from "./cron-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Automation recipient suggestions" });

suite.define(() => {
  it("shows the manual recipient recovery when suggestions fail and saves the typed recipient", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const delivery = { mode: "announce" as const, channel: "telegram", to: "-1001234567890" };
      const job = cronJob("morning-digest", "Morning digest", {
        agentId: "main",
        configRevision: "digest-v1",
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "Summarize today’s project updates." },
        delivery,
      });
      const details = "The Telegram directory is unavailable";
      const newRecipient = "-1002345678901";
      const gateway = await installMockGateway(page, {
        featureMethods: cronSidebarFeatureMethods,
        methodResponses: {
          "conversations.list": { __mockError: { code: "UNAVAILABLE", message: details } },
          "cron.get": job,
          "cron.list": cronList([job], "digest-inventory"),
          "cron.runs": cronRuns([]),
          "cron.status": { enabled: true, jobs: 1 },
        },
      });

      await page.goto(suite.server.baseUrl + "automations");
      await openAutomation(page, job.id);
      expect(new URL(page.url()).pathname).toBe("/automations");
      expect(new URL(page.url()).searchParams.get("job")).toBe(job.id);
      const alert = page
        .getByRole("alert")
        .filter({ hasText: "Couldn’t load recipient suggestions." });
      await alert.waitFor();
      expect((await gateway.waitForRequest("conversations.list")).params).toMatchObject({
        channel: "telegram",
        agentId: "main",
      });
      expect(await page.getByRole("button", { name: "Retry", exact: true }).count()).toBe(0);
      const detailCopy = (await alert.textContent())?.trim();
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await page.locator("fieldset.cron-editor").waitFor();
      const errorCopy = (await alert.textContent())?.trim();

      const advanced = page
        .locator("details.cron-advanced > summary")
        .filter({ hasText: "Advanced" });
      const results = page.locator("details.cron-advanced .settings-section").filter({
        has: page.getByRole("heading", { name: "Results", exact: true }),
      });
      const recipient = results.locator("input#cron-delivery-to");
      expect(await recipient.isVisible()).toBe(false);
      await advanced.click();
      await results.getByText("Recipient", { exact: true }).waitFor();
      await recipient.fill(newRecipient);
      expect(await gateway.getRequests("cron.update")).toHaveLength(0);
      const updateCount = await gateway.deferNext("cron.update");
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      const { params } = await gateway.waitForRequest("cron.update", { after: updateCount });
      expect(params).toMatchObject({
        id: job.id,
        expectedConfigRevision: "digest-v1",
        patch: { delivery: { mode: "announce", channel: "telegram", to: newRecipient } },
      });
      // Have the fixture return the submitted recipient on the next load.
      const saved = {
        ...job,
        configRevision: "digest-v2",
        delivery: { ...delivery, to: (params as CronUpdateParams).patch.delivery?.to ?? undefined },
      };
      await gateway.setMethodResponse("cron.get", saved);
      await gateway.setMethodResponse("cron.list", cronList([saved], "digest-inventory-saved"));
      await gateway.resolveDeferred("cron.update", saved);
      await page.locator('.cron-page[data-view="detail"]').waitFor();
      await page.reload();
      await editAutomation(page, job.id);
      await advanced.click();
      expect(await recipient.inputValue()).toBe(newRecipient);
      const expected = `Couldn’t load recipient suggestions. You can enter the recipient in the editor under Advanced → Results. Details: ${details}`;
      expect([detailCopy, errorCopy]).toEqual([expected, expected]);
    });
  });
});
