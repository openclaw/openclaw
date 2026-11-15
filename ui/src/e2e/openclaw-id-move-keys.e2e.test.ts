import { mkdir } from "node:fs/promises";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  deriveRootSigner,
  encodeKit,
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  generateKitSecret,
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

const suite = createControlUiE2eSuite({ name: "OpenClaw ID Move to new keys" });
const hostname = "studio-e61zr.crabd.xyz";
const evidence = process.env.OCID_MENU_EVIDENCE;

// The fixture answers every openclawId.authority action with one object: the account's link
// code, the re-bind preparation (whose root is the kit's) and the commit result.
async function authorityFixture() {
  const secret = generateKitSecret();
  const root = await deriveRootSigner(secret);
  const iroh = () => formatIrohEndpointKey(randomBytes(32));
  const ed = () => formatEd25519PublicKey(randomBytes(32));
  return {
    kit: await encodeKit(secret),
    response: {
      code: "SYNTHETIC-LINK-CODE",
      claw_id: "c".repeat(32),
      hostname,
      root_pub: formatEd25519PublicKey(root.publicKey),
      k_srv: iroh(),
      k_gw: ed(),
      binding_seq: 2,
      root_epoch: ROOT_EPOCH,
      current: { k_srv: iroh(), k_gw: ed(), binding_seq: 1 },
      published: { error: "not_found", detail: "not registered" },
      ok: true,
      bindingSeq: 2,
    },
  };
}

async function openMenu(
  page: Page,
  options: { status: Record<string, unknown>; publication?: Record<string, unknown> },
  authority: Record<string, unknown>,
) {
  const scenario = {
    sessionKey: "agent:main:move-keys-proof",
    featureMethods: [
      ...defaultControlUiFeatureMethods,
      "openclawId.status",
      "openclawId.people",
      "openclawId.authority",
    ],
    methodResponses: {
      "openclawId.authority": authority,
      "openclawId.people": {
        link: {
          linked: true,
          hostname,
          ...(options.publication ? { publication: options.publication } : {}),
        },
      },
      "openclawId.status": {
        status: options.status,
        channel: "local_operator",
        owner: true,
        ownerDeviceCount: 2,
        connection: {
          kind: "local",
          accountEmail: "owner@example.test",
          accountName: "Demo owner",
        },
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
  await page.goto(`${suite.server.baseUrl}/new`);
  await page.waitForFunction(() => window.openclawControlUi?.snapshot().ready);
  await page.locator("openclaw-app-sidebar:visible .sidebar-identity-card").click();
  const menu = page.locator('.sidebar-identity-menu[data-phase="open"]');
  await menu.waitFor();
  await gateway.waitForRequest("openclawId.status");
  return { menu, gateway };
}

async function capture(page: Page, name: string) {
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${evidence}/${name}.png`, animations: "disabled" });
  }
}

suite.define(() => {
  it("warns about key problems on this computer, each with its fix", async () => {
    const cases = [
      {
        name: "keys-refused",
        status: { state: "keys_refused", key: "gateway", reason: "keys_missing" },
        text: "Remote access is off: a key file is missing",
        action: "Move to new keys",
      },
      {
        name: "binding-superseded",
        status: { state: "on", tunnel: { state: "running", relayOnline: false } },
        publication: { state: "failed", code: "binding_superseded", message: "x" },
        text: "Newer keys are in use for this claw",
        action: "Move to new keys",
      },
      {
        name: "needs-link-code",
        status: { state: "on", tunnel: { state: "running", relayOnline: true } },
        publication: { state: "failed", code: "needs_link_code", message: "x" },
        text: "New keys aren't published yet",
        action: "Publish new keys",
      },
    ];
    for (const entry of cases) {
      await suite.withPage(
        { ...createControlUiE2eContextOptions(), viewport: { width: 1280, height: 844 } },
        async ({ page }) => {
          const { menu } = await openMenu(page, entry, {});
          await menu.getByText(entry.text, { exact: true }).waitFor();
          expect(
            await menu.getByRole("menuitem", { name: entry.action, exact: true }).count(),
          ).toBe(1);
          await capture(page, `menu-${entry.name}`);
          if (entry.name !== "needs-link-code") {
            await page.keyboard.press("Escape");
            await page.locator("openclaw-sidebar-attention:visible .sidebar-issues-button").click();
            const warning = page.locator('[data-attention-kind="openClawIdKeys"]');
            await warning.getByText(entry.text, { exact: true }).waitFor();
            await warning.locator("summary").click();
            await warning.getByRole("button", { name: "Move to new keys", exact: true }).waitFor();
            await capture(page, `inbox-${entry.name}`);
          }
        },
      );
    }
  });

  it.each(["account-menu", "inbox"])(
    "moves to new keys from %s after fingerprint confirmation",
    async (entry) => {
      const fixture = await authorityFixture();
      await suite.withPage(
        { ...createControlUiE2eContextOptions(), viewport: { width: 1280, height: 844 } },
        async ({ page }) => {
          const { menu, gateway } = await openMenu(
            page,
            { status: { state: "keys_refused", key: "endpoint", reason: "keys_missing" } },
            fixture.response,
          );
          const warning = page.locator('[data-attention-kind="openClawIdKeys"]');
          if (entry === "inbox") {
            await page.keyboard.press("Escape");
            await page.locator("openclaw-sidebar-attention:visible .sidebar-issues-button").click();
            await warning.locator("summary").click();
            await warning.getByRole("button", { name: "Move to new keys", exact: true }).click();
          } else {
            await menu.getByRole("menuitem", { name: "Move to new keys", exact: true }).click();
          }
          const dialog = page.locator("openclaw-modal-dialog .openclaw-id-move-keys");
          await dialog.waitFor();
          await dialog.getByLabel("Recovery code").fill(fixture.kit);
          await capture(page, "dialog-recovery-code");
          await dialog.getByRole("button", { name: "Check", exact: true }).click();
          await dialog.getByText("Confirm the new keys", { exact: true }).waitFor();
          await expect
            .poll(() => dialog.getByText("matches your recovery kit", { exact: true }).count())
            .toBe(1);
          expect(
            await dialog
              .locator(".openclaw-id-move-keys__row")
              .evaluateAll((rows) => rows.map((row) => getComputedStyle(row).display)),
          ).toEqual(["flex", "flex", "flex", "flex"]);
          await capture(page, `dialog-confirm-${entry}`);
          await gateway.setMethodResponse("openclawId.status", {
            status: { state: "on" },
            channel: "local_operator",
            owner: true,
            link: { linked: true, hostname },
            services: {},
          });
          await gateway.setMethodResponse("openclawId.people", {
            link: {
              linked: true,
              hostname,
              publication: {
                state: "failed",
                code: "binding_superseded",
                message: "newer binding",
              },
            },
          });
          await dialog.getByRole("button", { name: "Move to new keys", exact: true }).click();
          await dialog.waitFor({ state: "detached" });
          await page.locator("openclaw-sidebar-attention:visible .sidebar-issues-button").click();
          await expect.poll(() => warning.textContent()).toContain("Newer keys are in use");
          await gateway.setMethodResponse("openclawId.people", {
            link: {
              linked: true,
              hostname,
              publication: { state: "published", ownerAccountId: "fixture", snapshotSeq: 1 },
            },
          });
          await gateway.emitGatewayEvent("openclawId.people.changed", {});
          await expect
            .poll(() => page.locator('[data-attention-kind="openClawIdKeys"]').count())
            .toBe(0);
          const actions = (await gateway.getRequests())
            .filter((request) => request.method === "openclawId.authority")
            .map((request) => (request.params as { action: string }).action);
          expect(actions).toEqual(["account_link_code", "rebind_prepare", "rebind_commit"]);
          const commit = (await gateway.getRequests()).find(
            (request) =>
              request.method === "openclawId.authority" &&
              (request.params as { action: string }).action === "rebind_commit",
          );
          // The browser signed the binding with the kit's root; the code came from the account.
          expect(commit?.params).toMatchObject({
            code: "SYNTHETIC-LINK-CODE",
            binding: {
              type: "ServerBinding",
              signer: fixture.response.root_pub,
              body: { k_srv: fixture.response.k_srv, k_gw: fixture.response.k_gw, binding_seq: 2 },
            },
          });
        },
      );
    },
  );
});
