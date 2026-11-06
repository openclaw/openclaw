import { mkdir, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.ts";
import {
  createControlUiMockBootstrapConfig,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "OpenClaw ID account menu" });
const label = "Sign in with OpenClaw ID";

suite.define(() => {
  it("shows private-preview denial without a link action", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { width: 1280, height: 844 } },
      async ({ page }) => {
        const scenario = {
          sessionKey: "agent:main:preview-proof",
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "openclawId.status",
            "openclawId.authority",
          ],
          methodResponses: {
            "openclawId.status": {
              status: { state: "on" },
              channel: "local_operator",
              owner: true,
              connection: { kind: "local" },
              link: { linked: false },
              services: {
                environment: "staging",
                issuerUrl: "https://issuer.example.test",
                clientId: "control-ui",
                loaderDomain: "claws.example.test",
              },
            },
          },
        };
        const gateway = await installMockGateway(page, scenario);
        await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              ...createControlUiMockBootstrapConfig(scenario),
              openclawIdEnabled: true,
            }),
          }),
        );
        await page.addInitScript(() =>
          localStorage.setItem(
            "openclaw.openclawId.account",
            JSON.stringify({
              sub: "fixture-outsider",
              email: "outsider@example.test",
              exp: 4102444800,
              idToken: "synthetic-not-a-token",
              previewAccess: false,
            }),
          ),
        );
        await page.goto(`${suite.server.baseUrl}/new`);
        await page.waitForFunction(() => window.openclawControlUi?.snapshot().ready);
        await page.locator("openclaw-app-sidebar:visible .sidebar-identity-card").click();
        const menu = page.locator('.sidebar-identity-menu[data-phase="open"]');
        await menu
          .getByText(
            "OpenClaw ID is in private preview, and outsider@example.test isn't enabled yet.",
            { exact: true },
          )
          .waitFor();
        expect(await menu.getByText("Private preview · staging", { exact: true }).count()).toBe(1);
        expect(
          await menu
            .getByRole("menuitem", { name: "Sign out / use another account", exact: true })
            .count(),
        ).toBe(1);
        expect(await menu.locator('[data-value="openclaw-id:make-reachable"]').count()).toBe(0);
        expect(
          (await gateway.getRequests()).filter(
            (request) => request.method === "openclawId.authority",
          ),
        ).toEqual([]);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({
          path: `${suite.artifactDir}/preview-denied.png`,
          animations: "disabled",
        });
      },
    );
  });

  it("uses one accessible sign-in button and contains signed-in multiline rows", async () => {
    for (const width of [1280, 390]) {
      for (const colorScheme of ["light", "dark"] as const) {
        for (const signedIn of [false, true]) {
          await suite.withPage(
            {
              ...createControlUiE2eContextOptions(),
              viewport: { width, height: 844 },
              colorScheme,
            },
            async ({ page }) => {
              const scenario = {
                sessionKey: "agent:main:menu-proof",
                featureMethods: [
                  ...defaultControlUiFeatureMethods,
                  "openclawId.status",
                  "openclawId.authority",
                ],
                methodResponses: {
                  "openclawId.authority": {
                    authorizationUrl: "about:blank",
                    state: "synthetic-sign-in",
                  },
                  "openclawId.status": {
                    status: { state: "on", tunnel: { state: "running", relayOnline: true } },
                    channel: "local_operator",
                    owner: true,
                    ownerDeviceCount: 2,
                    connection: {
                      kind: "local",
                      accountEmail: "owner@example.test",
                      accountName: "Demo owner",
                    },
                    link: { linked: true, hostname: "a-long-demo-claw-e61zr.crabd.xyz" },
                    services: {
                      issuerUrl: "https://issuer.example.test",
                      clientId: "control-ui",
                      loaderDomain: "claws.example.test",
                    },
                  },
                },
              };
              const gateway = await installMockGateway(page, scenario);
              const bootstrap = {
                ...createControlUiMockBootstrapConfig(scenario),
                openclawIdEnabled: true,
              };
              await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, (route) =>
                route.fulfill({
                  status: 200,
                  contentType: "application/json",
                  body: JSON.stringify(bootstrap),
                }),
              );
              if (signedIn) {
                await page.addInitScript(() =>
                  localStorage.setItem(
                    "openclaw.openclawId.account",
                    JSON.stringify({
                      sub: "fixture-owner",
                      exp: 4102444800,
                      idToken: "synthetic-not-a-token",
                    }),
                  ),
                );
              }
              await page.setViewportSize({ width, height: 844 });
              await page.goto(`${suite.server.baseUrl}/new`);
              await page.waitForFunction(() => window.openclawControlUi?.snapshot().ready);
              if (width === 390) {
                await navigationDrawerToggle(page).click();
              }
              await page.locator("openclaw-app-sidebar:visible .sidebar-identity-card").click();
              const menu = page.locator('.sidebar-identity-menu[data-phase="open"]');
              await menu.waitFor();
              await gateway.waitForRequest("openclawId.status");
              await menu
                .getByText(signedIn ? "Remote access on" : label, { exact: true })
                .waitFor();
              const target = signedIn
                ? menu.locator(".sidebar-openclaw-id__status")
                : menu.locator('[data-value="openclaw-id:sign-in"]');
              await target.hover();
              await page.evaluate(() => document.fonts.ready);
              const geometry = await menu.evaluate((element) =>
                [
                  ...element.querySelectorAll(
                    ".sidebar-customize-menu__item, .sidebar-openclaw-id__status",
                  ),
                ].map((row) => {
                  const rect = row.getBoundingClientRect();
                  const lines = [
                    ...row.querySelectorAll(
                      ".sidebar-openclaw-id__lines, .sidebar-identity-menu__identity",
                    ),
                  ].map((line) => {
                    const r = line.getBoundingClientRect();
                    return { top: r.top, bottom: r.bottom };
                  });
                  return {
                    text: row.textContent,
                    top: rect.top,
                    bottom: rect.bottom,
                    height: rect.height,
                    cssHeight: getComputedStyle(row).height,
                    lines,
                  };
                }),
              );
              // Optional visual artifacts use the exact production menu; CI remains a behavioral test.
              if (process.env.OCID_MENU_EVIDENCE) {
                const root = process.env.OCID_MENU_EVIDENCE;
                await mkdir(root, { recursive: true });
                const stem = `${width}-${colorScheme}-${signedIn ? "signed-in" : "signed-out"}`;
                await page.screenshot({ path: `${root}/${stem}.png`, animations: "disabled" });
                await writeFile(
                  `${root}/${stem}.json`,
                  JSON.stringify({ geometry, aria: await menu.ariaSnapshot() }, null, 2),
                );
              }
              for (const row of geometry) {
                for (const line of row.lines) {
                  expect.soft(line.top, row.text ?? "row").toBeGreaterThanOrEqual(row.top);
                  expect.soft(line.bottom, row.text ?? "row").toBeLessThanOrEqual(row.bottom);
                }
              }
              if (!signedIn) {
                const button = menu.getByRole("button", { name: label, exact: true });
                expect.soft(await button.count()).toBe(1);
                expect
                  .soft(await menu.locator('[data-value="openclaw-id:sign-in"] svg').count())
                  .toBe(0);
                expect.soft(await menu.locator(".sidebar-customize-menu__title").count()).toBe(0);
                expect
                  .soft(
                    await menu
                      .getByText("Reach this claw from other devices and invite people", {
                        exact: true,
                      })
                      .count(),
                  )
                  .toBe(0);
                if (await button.count()) {
                  // The menu owns arrow navigation; Enter activates the native button once.
                  await menu.getByRole("menuitem", { name: "Settings", exact: true }).focus();
                  await page.keyboard.press("ArrowUp");
                  expect
                    .soft(await button.evaluate((node) => node === document.activeElement))
                    .toBe(true);
                  const popup = page.context().waitForEvent("page");
                  await page.keyboard.press("Enter");
                  const opened = await popup;
                  await gateway.waitForRequest("openclawId.authority");
                  expect
                    .soft(
                      (await gateway.getRequests()).filter(
                        (request) => request.method === "openclawId.authority",
                      ),
                    )
                    .toHaveLength(1);
                  await opened.close();
                  await menu.waitFor({ state: "hidden" });
                }
              } else {
                expect
                  .soft(
                    await menu.getByRole("menuitem", { name: "Your devices", exact: true }).count(),
                  )
                  .toBe(1);
              }
            },
          );
        }
      }
    }
  });
});
