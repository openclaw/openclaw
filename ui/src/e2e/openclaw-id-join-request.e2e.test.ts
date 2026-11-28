import { mkdir } from "node:fs/promises";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.ts";
import {
  createControlUiMockBootstrapConfig,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "OpenClaw ID join requests" });
const evidence = process.env.OCID_JOIN_REQUEST_EVIDENCE;

async function openControlUi(page: Page) {
  const now = Math.floor(Date.now() / 1000);
  const scenario = {
    sessionKey: "agent:main:join-request-proof",
    featureMethods: [...defaultControlUiFeatureMethods, "openclawId.status", "openclawId.people"],
    methodResponses: {
      "openclawId.people": {
        link: {
          linked: true,
          invites: [
            {
              inviteId: "ada",
              label: "ada@example.test",
              status: "pending",
              pending: {
                requestedAt: now - 120,
                decideBy: now + 3 * 86_400,
                reported: { email: "ada@example.test", displayName: "Ada Lovelace" },
              },
            },
          ],
        },
      },
      "openclawId.status": {
        status: { state: "on", tunnel: { state: "running", relayOnline: true } },
        channel: "local_operator",
        owner: true,
        link: { linked: true, hostname: "studio-e61zr.crabd.xyz" },
        services: { issuerUrl: null, discoveryUrl: null, loaderDomain: null },
      },
    },
  };
  const gateway = await installMockGateway(page, scenario);
  const bootstrap = { ...createControlUiMockBootstrapConfig(scenario), openclawIdEnabled: true };
  await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(bootstrap),
    }),
  );
  await page.goto(new URL("new", suite.server.baseUrl).href);
  await page.waitForFunction(() => window.openclawControlUi?.snapshot().ready);
  await gateway.waitForRequest("openclawId.status");
}

async function capture(page: Page, name: string) {
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${evidence}/${name}.png`, animations: "disabled" });
  }
}

suite.define(() => {
  it("prompts an owner about a join request and lists it in the Inbox", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await openControlUi(page);
      const prompt = page.locator("openclaw-modal-dialog .exec-approval-card");
      await expect
        .poll(() => prompt.locator(".exec-approval-title").textContent())
        .toBe("Ada Lovelace asked to join");
      expect(await prompt.locator(".exec-approval-sub").first().textContent()).toBe(
        "3d left to decide",
      );
      await capture(page, "prompt");
      await prompt.getByRole("button", { name: "Later" }).click();
      await expect.poll(() => prompt.count()).toBe(0);

      await page.locator("openclaw-sidebar-attention:visible .sidebar-issues-button").click();
      const row = page.locator('[data-attention-kind="openClawIdRequest"]');
      await expect.poll(() => row.textContent()).toContain("Ada Lovelace asked to join");
      expect(await row.textContent()).toContain("3d left to decide");
      await capture(page, "inbox");
      await row.locator("a").click();
      await expect
        .poll(() => new URL(page.url()).search)
        .toBe("?plugin=openclaw-id-access&id=access");

      await page.reload();
      await page.waitForFunction(() => window.openclawControlUi?.snapshot().ready);
      await page.locator("openclaw-sidebar-attention:visible .sidebar-issues-button").click();
      await expect.poll(() => row.count()).toBe(1);
      // Later holds across reloads until another request arrives.
      expect(await prompt.count()).toBe(0);
    });
  });
});
