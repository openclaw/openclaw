import type { SessionsStorageStatusResult } from "@openclaw/gateway-protocol";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, type MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { expectText } from "./sidebar-assertions.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Session storage settings",
  startServerBeforeBrowser: true,
});
const route = "settings/ai-agents?section=session";
const agentStorage = (
  agentId: string,
  hotTranscripts: number,
  coldTranscripts: number,
  databaseBytes: number,
  walBytes = 0,
  archiveBytes = 0,
  embeddedArchiveBytes = 0,
) => ({
  agentId,
  storePath: `/synthetic/${agentId}/agent.sqlite`,
  hotTranscripts,
  coldTranscripts,
  databaseBytes,
  walBytes,
  archiveBytes,
  embeddedArchiveBytes,
});

const storage: SessionsStorageStatusResult = {
  agents: [
    agentStorage("main", 240, 760, 734003200, 10485760, 125829120, 10485760),
    agentStorage("research", 60, 140, 314572800, 0, 41943040),
  ],
  maintenance: {
    running: false,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastError: null,
    archivedTranscripts: 0,
    externalizedTranscripts: 0,
  },
};
const objectSchema = (properties: Record<string, unknown>) => ({ type: "object", properties });
const schema = {
  schema: objectSchema({
    session: objectSchema({
      maintenance: objectSchema({
        coldStorage: objectSchema({
          enabled: { type: "boolean", default: false },
          afterDays: { type: "integer", minimum: 1, default: 30 },
        }),
      }),
    }),
  }),
  uiHints: {},
};
function snapshot(enabled = false, afterDays = 30, hash = "storage-e2e") {
  const config = { session: { maintenance: { coldStorage: { enabled, afterDays } } } };
  return {
    config,
    hash,
    appliedConfigHash: hash,
    raw: JSON.stringify(config),
    valid: true,
    issues: [],
  };
}
function submittedConfig(request: MockGatewayRequest): unknown {
  const raw = asNullableRecord(request.params)?.raw;
  if (typeof raw !== "string") {
    throw new Error("Expected a serialized config write");
  }
  return JSON.parse(raw);
}
const maintenanceStatus = (maintenance: Partial<SessionsStorageStatusResult["maintenance"]>) => ({
  ...storage,
  maintenance: { ...storage.maintenance, ...maintenance },
});
function row(page: Page, title: string) {
  return page
    .locator("div.settings-row")
    .filter({ has: page.locator(".settings-row__title").getByText(title, { exact: true }) });
}
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const ageInput = (page: Page) => page.getByRole("spinbutton", { name: "Archive after (days)" });
const archiveSwitch = (page: Page) =>
  page.getByRole("switch", { name: /Archive older transcripts/ });
const expectRow = (page: Page, title: string, text: string) =>
  expect.poll(() => row(page, title).textContent()).toContain(text);
async function openStorage(page: Page, options: Parameters<typeof installMockGateway>[1] = {}) {
  const gateway = await installMockGateway(page, {
    ...options,
    methodResponses: {
      "config.get": snapshot(),
      "config.schema": schema,
      "sessions.storage.status": storage,
      ...options.methodResponses,
    },
  });
  await page.goto(`${suite.server.baseUrl}${route}`);
  return gateway;
}

suite.define(() => {
  it("shows inventory, saves whole-day policy without restart, and runs only applied settings", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 1100 }, colorScheme: "dark" },
      async ({ page }) => {
        const gateway = await openStorage(page);
        const run = button(page, "Run now");
        await expectRow(page, "Transcripts", "1200");
        await expectRow(page, "Transcripts", "300 uncompressed · 900 archived");
        await page.getByText("Details by agent", { exact: true }).click();
        await expectRow(page, "research", "140 archived");
        await page.getByText("Details by agent", { exact: true }).click();
        await expect.poll(() => run.isDisabled()).toBe(true);
        await expectRow(page, "Compressed archives in database", "10.0 MiB");
        expect(await row(page, "Compressed archives in database").textContent()).toContain(
          "Included in the database size above.",
        );

        const age = ageInput(page);
        for (const invalid of ["0", "1.5", ""]) {
          await age.fill(invalid);
          await age.blur();
          expect(await age.evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(false);
          expect(await gateway.getRequests("config.set")).toHaveLength(0);
        }
        await age.fill("14");
        await age.blur();
        const firstSave = await gateway.waitForRequest("config.set");
        expect(submittedConfig(firstSave)).toMatchObject({
          session: { maintenance: { coldStorage: { afterDays: 14 } } },
        });
        await expectText(page.locator("openclaw-settings-save-indicator"), "Saved");
        await row(page, "Archive older transcripts").getByRole("switch").click();
        await expect.poll(async () => (await gateway.getRequests("config.set")).length).toBe(2);
        const saves = await gateway.getRequests("config.set");
        expect(submittedConfig(saves[1]!)).toHaveProperty("session.maintenance.coldStorage", {
          enabled: true,
          afterDays: 14,
        });
        // A saved policy is not runnable until the Gateway confirms it was applied.
        expect(await run.isDisabled()).toBe(true);
        await gateway.setMethodResponse("config.get", snapshot(true, 14, "storage-applied"));
        await expect.poll(() => run.isEnabled()).toBe(true);
        expect(await gateway.getRequests("config.apply")).toHaveLength(0);
        expect(await gateway.getSocketCount()).toBe(1);

        await gateway.deferNext("sessions.storage.run");
        await run.click();
        await gateway.waitForRequest("sessions.storage.run");
        expect(await button(page, "Running").isDisabled()).toBe(true);
        const running = maintenanceStatus({ running: true, lastStartedAt: 1789135190000 });
        await gateway.setMethodResponse("sessions.storage.status", running);
        await gateway.resolveDeferred("sessions.storage.run", running);
        await page.getByRole("status").filter({ hasText: "Background batch started." }).waitFor();
        expect(await page.getByText("Batch completed", { exact: false }).count()).toBe(0);
        await expectRow(page, "Background maintenance", "Running");
        const initialReads = (await gateway.getRequests("sessions.storage.status")).length;
        await expect
          .poll(async () => (await gateway.getRequests("sessions.storage.status")).length)
          .toBeGreaterThan(initialReads);
        await gateway.setMethodResponse(
          "sessions.storage.status",
          maintenanceStatus({
            archivedTranscripts: 12,
            lastCompletedAt: 1789135200000,
          }),
        );
        await page
          .getByRole("status")
          .filter({ hasText: "Batch completed. 12 transcripts archived." })
          .waitFor();
        await page.setViewportSize({ width: 390, height: 844 });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.reload();
        await expect.poll(() => age.inputValue()).toBe("14");
        await expect.poll(() => archiveSwitch(page).isChecked()).toBe(true);
      },
    );
  });

  it("reports storage and worker failures without presenting a successful empty inventory", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await openStorage(page, {
        methodResponses: {
          "config.get": snapshot(true),
          "sessions.storage.status": {
            __mockError: { code: "UNAVAILABLE", message: "Archive missing" },
          },
        },
      });
      const run = button(page, "Run now");
      await page.getByRole("alert").filter({ hasText: "Archive missing" }).waitFor();
      expect(await row(page, "Transcripts").count()).toBe(0);
      expect(await run.isDisabled()).toBe(true);
      await gateway.setMethodResponse("sessions.storage.status", storage);
      await button(page, "Refresh").click();
      await expectRow(page, "Transcripts", "1200");
      await gateway.setMethodResponse("sessions.storage.run", {
        __mockError: { code: "UNAVAILABLE", message: "Not enough disk space" },
      });
      await run.click();
      await page.getByRole("alert").filter({ hasText: "Not enough disk space" }).waitFor();
      expect(await page.getByText("Batch completed", { exact: false }).count()).toBe(0);
    });
  });

  it("keeps storage inspection and configuration disabled for a read-only operator", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await openStorage(page, {
        operatorScopes: ["operator.read"],
      });
      await page
        .getByText("Administrator access is required to inspect session storage.")
        .waitFor();
      expect(await ageInput(page).isDisabled()).toBe(true);
      expect(await archiveSwitch(page).isDisabled()).toBe(true);
      for (const method of ["sessions.storage.status", "config.set"]) {
        expect(await gateway.getRequests(method)).toHaveLength(0);
      }
    });
  });
});
