import path from "node:path";
import type { SessionsStorageStatusResult } from "@openclaw/gateway-protocol";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway, type MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Session storage settings",
  startServerBeforeBrowser: true,
});
const route = "settings/ai-agents?section=session";
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

const storage: SessionsStorageStatusResult = {
  agents: [
    {
      agentId: "main",
      storePath: "/synthetic/main/agent.sqlite",
      hotTranscripts: 240,
      coldTranscripts: 760,
      databaseBytes: 734003200,
      walBytes: 10485760,
      archiveBytes: 125829120,
      embeddedArchiveBytes: 10485760,
    },
    {
      agentId: "research",
      storePath: "/synthetic/research/agent.sqlite",
      hotTranscripts: 60,
      coldTranscripts: 140,
      databaseBytes: 314572800,
      walBytes: 0,
      archiveBytes: 41943040,
      embeddedArchiveBytes: 0,
    },
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
const schema = {
  schema: {
    type: "object",
    properties: {
      session: {
        type: "object",
        properties: {
          maintenance: {
            type: "object",
            properties: {
              coldStorage: {
                type: "object",
                properties: {
                  enabled: { type: "boolean", default: false },
                  afterDays: { type: "integer", minimum: 1, default: 30 },
                },
              },
            },
          },
        },
      },
    },
  },
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
  const params = request.params;
  if (
    !params ||
    typeof params !== "object" ||
    !("raw" in params) ||
    typeof params.raw !== "string"
  ) {
    throw new Error("Expected a serialized config write");
  }
  return JSON.parse(params.raw);
}
function row(page: Page, title: string) {
  return page
    .locator("div.settings-row")
    .filter({ has: page.locator(".settings-row__title").getByText(title, { exact: true }) });
}
async function capture(page: Page, directory: string | null, filename: string) {
  if (directory) {
    await page.screenshot({ path: path.join(directory, filename), animations: "disabled" });
  }
}

suite.define(() => {
  it("shows inventory, saves whole-day policy without restart, and runs only applied settings", async () => {
    const directory = captureProof ? createControlUiE2eArtifactDir("session-storage-after") : null;
    await suite.withPage(
      { viewport: { width: 1440, height: 1100 }, colorScheme: "dark" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": snapshot(),
            "config.schema": schema,
            "sessions.storage.status": storage,
          },
        });
        await page.goto(`${suite.server.baseUrl}${route}`);
        await expect.poll(() => row(page, "Transcripts").textContent()).toContain("1200");
        await expect
          .poll(() => row(page, "Transcripts").textContent())
          .toContain("300 uncompressed · 900 archived");
        await page.getByText("Details by agent", { exact: true }).click();
        await expect.poll(() => row(page, "research").textContent()).toContain("140 archived");
        await page.getByText("Details by agent", { exact: true }).click();
        await expect
          .poll(() => page.getByRole("button", { name: "Run now", exact: true }).isDisabled())
          .toBe(true);
        await expect
          .poll(() => row(page, "Compressed archives in database").textContent())
          .toContain("10.0 MiB");
        expect(await row(page, "Compressed archives in database").textContent()).toContain(
          "Included in the database size above.",
        );
        await capture(page, directory, "after-desktop.png");

        const age = page.getByRole("spinbutton", { name: "Archive after (days)" });
        for (const invalid of ["0", "1.5", ""]) {
          await age.fill(invalid);
          await age.blur();
          expect(await age.evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(false);
          expect(await gateway.getRequests("config.set")).toHaveLength(0);
        }
        await age.fill("14");
        await age.blur();
        const firstSave = await gateway.waitForRequest("config.set");
        expect(submittedConfig(firstSave)).toHaveProperty(
          "session.maintenance.coldStorage.afterDays",
          14,
        );
        await expect
          .poll(() => page.locator("openclaw-settings-save-indicator").textContent())
          .toContain("Saved");
        await row(page, "Archive older transcripts").locator("wa-switch").click();
        await expect.poll(async () => (await gateway.getRequests("config.set")).length).toBe(2);
        const saves = await gateway.getRequests("config.set");
        expect(submittedConfig(saves[1]!)).toHaveProperty("session.maintenance.coldStorage", {
          enabled: true,
          afterDays: 14,
        });
        // A saved policy is not runnable until the Gateway confirms it was applied.
        expect(await page.getByRole("button", { name: "Run now", exact: true }).isDisabled()).toBe(
          true,
        );
        await gateway.setMethodResponse("config.get", snapshot(true, 14, "storage-applied"));
        await expect
          .poll(() => page.getByRole("button", { name: "Run now", exact: true }).isEnabled())
          .toBe(true);
        expect(await gateway.getRequests("config.apply")).toHaveLength(0);
        expect(await gateway.getSocketCount()).toBe(1);

        await gateway.deferNext("sessions.storage.run");
        await page.getByRole("button", { name: "Run now", exact: true }).click();
        await gateway.waitForRequest("sessions.storage.run");
        expect(await page.getByRole("button", { name: "Running", exact: true }).isDisabled()).toBe(
          true,
        );
        const running = {
          ...storage,
          maintenance: { ...storage.maintenance, running: true, lastStartedAt: 1789135190000 },
        };
        await gateway.setMethodResponse("sessions.storage.status", running);
        await gateway.resolveDeferred("sessions.storage.run", running);
        await page.getByRole("status").filter({ hasText: "Background batch started." }).waitFor();
        expect(await page.getByText("Batch completed", { exact: false }).count()).toBe(0);
        await expect
          .poll(() => row(page, "Background maintenance").textContent())
          .toContain("Running");
        const initialReads = (await gateway.getRequests("sessions.storage.status")).length;
        await expect
          .poll(async () => (await gateway.getRequests("sessions.storage.status")).length)
          .toBeGreaterThan(initialReads);
        await capture(page, directory, "after-accepted.png");
        const completed = {
          ...storage,
          maintenance: {
            ...storage.maintenance,
            archivedTranscripts: 12,
            lastCompletedAt: 1789135200000,
          },
        };
        await gateway.setMethodResponse("sessions.storage.status", completed);
        await page
          .getByRole("status")
          .filter({ hasText: "Batch completed. 12 transcripts archived." })
          .waitFor();
        await capture(page, directory, "after-run.png");
        await page.setViewportSize({ width: 390, height: 844 });
        await capture(page, directory, "after-mobile.png");
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.reload();
        await expect.poll(() => age.inputValue()).toBe("14");
        await expect
          .poll(() =>
            page
              .getByRole("switch", { name: /Archive older transcripts/ })
              .getAttribute("aria-checked"),
          )
          .toBe("true");
      },
    );
  });

  it("reports storage and worker failures without presenting a successful empty inventory", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "config.get": snapshot(true),
          "config.schema": schema,
          "sessions.storage.status": {
            __mockError: {
              code: "UNAVAILABLE",
              message: "Archive missing: recover the synthetic archive from backup.",
            },
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}${route}`);
      await page.getByRole("alert").filter({ hasText: "Archive missing" }).waitFor();
      expect(await row(page, "Transcripts").count()).toBe(0);
      expect(await page.getByRole("button", { name: "Run now", exact: true }).isDisabled()).toBe(
        true,
      );
      await gateway.setMethodResponse("sessions.storage.status", storage);
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect.poll(() => row(page, "Transcripts").textContent()).toContain("1200");
      await gateway.setMethodResponse("sessions.storage.run", {
        __mockError: { code: "UNAVAILABLE", message: "Not enough disk space to publish archive." },
      });
      await page.getByRole("button", { name: "Run now", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "Not enough disk space" }).waitFor();
      expect(await page.getByText("Batch completed", { exact: false }).count()).toBe(0);
    });
  });

  it("keeps storage inspection and configuration disabled for a read-only operator", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read"],
        methodResponses: {
          "config.get": snapshot(),
          "config.schema": schema,
          "sessions.storage.status": storage,
        },
      });
      await page.goto(`${suite.server.baseUrl}${route}`);
      await page
        .getByText("Administrator access is required to inspect session storage.")
        .waitFor();
      expect(
        await page.getByRole("spinbutton", { name: "Archive after (days)" }).isDisabled(),
      ).toBe(true);
      expect(
        await page.getByRole("switch", { name: /Archive older transcripts/ }).isDisabled(),
      ).toBe(true);
      expect(await gateway.getRequests("sessions.storage.status")).toHaveLength(0);
      expect(await gateway.getRequests("config.set")).toHaveLength(0);
    });
  });
});
