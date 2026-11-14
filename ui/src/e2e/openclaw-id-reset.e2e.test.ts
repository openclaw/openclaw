import { mkdir } from "node:fs/promises";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  randomBytes,
  ROOT_EPOCH,
} from "../../../packages/openclaw-id-protocol/src/index.ts";
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

const suite = createControlUiE2eSuite({ name: "OpenClaw ID Reset owner access" });
const hostname = "studio-e61zr.crabd.xyz";
const evidence = process.env.OCID_MENU_EVIDENCE;

// One object answers every openclawId.authority action: the reset preparation and its commit.
const authority = {
  claw_id: "c".repeat(32),
  hostname,
  root_pub: formatEd25519PublicKey(randomBytes(32)),
  k_srv: formatIrohEndpointKey(randomBytes(32)),
  k_gw: formatEd25519PublicKey(randomBytes(32)),
  binding_seq: 2,
  root_epoch: ROOT_EPOCH,
  owner_device_seq: 6,
  removes: { ownerDevices: 2, members: 1, nodes: 0, invites: 1 },
  ok: true,
  reset: true,
  bindingSeq: 2,
  publication: { state: "published", ownerAccountId: null, snapshotSeq: 5 },
};

async function openPage(page: Page, channel: "local_operator" | "tunnel") {
  const scenario = {
    sessionKey: "agent:main:reset-proof",
    featureMethods: [
      ...defaultControlUiFeatureMethods,
      "openclawId.status",
      "openclawId.people",
      "openclawId.authority",
    ],
    methodResponses: {
      "openclawId.authority": authority,
      "openclawId.people": {
        link: { linked: true, hostname, publication: authority.publication },
      },
      "openclawId.status": {
        status: { state: "on", tunnel: { state: "running", relayOnline: true } },
        channel,
        owner: true,
        ownerDeviceCount: 2,
        accountSignIn: channel === "local_operator" ? "popup" : null,
        remoteAccessSetup: channel === "local_operator" ? "local" : null,
        connection:
          channel === "local_operator"
            ? { kind: "local", accountEmail: "owner@example.test", accountName: "Demo owner" }
            : { kind: "owner", deviceLabel: "Laptop", ownerAccountId: null },
        link: { linked: true, hostname },
        services: {
          issuerUrl: "https://issuer.example.test",
          clientId: "control-ui",
          loaderDomain: "claws.example.test",
        },
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
  await page.addInitScript(() =>
    localStorage.setItem(
      "openclaw.openclawId.account",
      JSON.stringify({ sub: "fixture-owner", exp: 4102444800, idToken: "synthetic-not-a-token" }),
    ),
  );
  await page.goto(`${suite.server.baseUrl}settings/openclaw-id`);
  await page.waitForFunction(() => window.openclawControlUi?.snapshot().ready);
  await page.getByText(hostname, { exact: true }).first().waitFor();
  return gateway;
}

async function capture(page: Page, name: string) {
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${evidence}/${name}.png`, animations: "disabled" });
  }
}

const viewport = { ...createControlUiE2eContextOptions(), viewport: { width: 1280, height: 844 } };

suite.define(() => {
  it("resets owner access on this computer after the new kit is saved", async () => {
    await suite.withPage(viewport, async ({ page }) => {
      const gateway = await openPage(page, "local_operator");
      await capture(page, "page-local");
      await page.getByRole("button", { name: "Reset…", exact: true }).click();
      const dialog = page.locator("openclaw-modal-dialog .openclaw-id-reset");
      await dialog.waitFor();
      const makeKit = dialog.getByRole("button", { name: "Make a new recovery kit" });
      expect(await makeKit.isDisabled()).toBe(true);
      await dialog.getByLabel("Type studio to confirm").fill("studio");
      await capture(page, "dialog-confirm");
      await makeKit.click();
      await dialog.getByText("Save this new kit before you reset.", { exact: false }).waitFor();
      const commit = dialog.getByRole("button", { name: "Reset owner access", exact: true });
      expect(await commit.isDisabled()).toBe(true);
      await capture(page, "dialog-kit");
      await dialog.getByText("I've saved my recovery kit", { exact: false }).click();
      await commit.click();
      await gateway.waitForRequest("openclawId.authority", { match: { action: "reset_commit" } });
      await dialog.waitFor({ state: "detached" });
    });
  });

  it("shows one line instead of the Reset button over the tunnel", async () => {
    await suite.withPage(viewport, async ({ page }) => {
      await openPage(page, "tunnel");
      await page
        .getByText("Reset owner access is only available on the computer that runs this claw.")
        .waitFor();
      expect(await page.getByRole("button", { name: "Reset…" }).count()).toBe(0);
      await capture(page, "page-tunnel");
    });
  });
});
