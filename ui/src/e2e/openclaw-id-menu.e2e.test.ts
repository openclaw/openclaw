import { mkdir, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  generateEd25519Signer,
} from "../../../packages/openclaw-id-protocol/src/index.ts";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.ts";
import type {
  OpenClawIdLinkPreparation,
  OpenClawIdPublication,
  OpenClawIdStatusResult,
} from "../lib/openclaw-id/types.ts";
import {
  createControlUiMockBootstrapConfig,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { requireRecord } from "./chat-flow.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "OpenClaw ID account menu" });
const label = "Sign in with OpenClaw ID";

suite.define(() => {
  it("keeps remote-access completion compact and actions reachable after the real ceremony", async () => {
    const signer = await generateEd25519Signer();
    const preparation: OpenClawIdLinkPreparation = {
      claw_id: "78".repeat(16),
      hostname: "studio-test.claws.example.test",
      k_srv: formatIrohEndpointKey(signer.publicKey),
      k_gw: formatEd25519PublicKey(signer.publicKey),
      binding_seq: 1,
      root_epoch: 1,
    };
    for (const published of [true, false]) {
      await suite.withPage(
        { ...createControlUiE2eContextOptions(), viewport: { width: 390, height: 360 } },
        async ({ page }) => {
          const status: OpenClawIdStatusResult = {
            status: { state: "on", tunnel: { state: "running", relayOnline: published } },
            channel: "local_operator",
            accountSignIn: "popup",
            owner: true,
            ownerDeviceCount: 0,
            connection: { kind: "local", accountEmail: "owner@example.test" },
            link: { linked: false },
            services: {
              issuerUrl: "https://issuer.example.test",
              discoveryUrl: "https://discovery.example.test",
              clientId: "control-ui",
              loaderDomain: "claws.example.test",
            },
          };
          const publication: OpenClawIdPublication = published
            ? { state: "published", ownerAccountId: "fixture-owner", snapshotSeq: 1 }
            : {
                state: "failed",
                code: "unavailable",
                message: "Synthetic publication unavailable",
                retryable: true,
              };
          const scenario = {
            featureMethods: [
              ...defaultControlUiFeatureMethods,
              "openclawId.status",
              "openclawId.authority",
            ],
            methodResponses: { "openclawId.status": status },
          };
          const gateway = await installMockGateway(page, scenario, {
            requestHandlers: {
              "openclawId.authority": (input) => {
                const params = requireRecord(input);
                if (params.action === "account_link_code") {
                  return { code: "synthetic-code" };
                }
                if (params.action === "check_name") {
                  return {
                    name: "claw",
                    accountTag: "test",
                    hostname: preparation.hostname,
                    available: true,
                  };
                }
                if (params.action === "prepare") {
                  return preparation;
                }
                if (params.action === "commit") {
                  return { publication };
                }
                throw new Error("Unexpected authority operation");
              },
            },
          });
          await page.route("**" + CONTROL_UI_BOOTSTRAP_CONFIG_PATH, (route) =>
            route.fulfill({
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
                sub: "fixture-owner",
                exp: 4102444800,
                email: "owner@example.test",
                name: "Demo owner",
                idToken: "synthetic-not-a-token",
              }),
            ),
          );
          await page.goto(suite.server.baseUrl + "new");
          await navigationDrawerToggle(page).click();
          await page.locator("openclaw-app-sidebar:visible .sidebar-identity-card").click();
          await page.locator('[data-value="openclaw-id:make-reachable"]').click();
          const dialog = page.getByRole("dialog", { name: "Turn on remote access", exact: true });
          await dialog.getByText(/Available: https/).waitFor();
          await dialog.getByRole("button", { name: "Continue", exact: true }).click();
          const password = dialog.locator('input[autocomplete="new-password"]');
          await password.waitFor();
          expect(await password.getAttribute("type")).toBe("password");
          expect(
            await dialog.getByRole("button", { name: "Continue", exact: true }).isDisabled(),
          ).toBe(true);
          await dialog.locator('input[type="checkbox"]').check();
          await dialog.getByRole("button", { name: "Continue", exact: true }).click();
          await gateway.waitForRequest("openclawId.authority", { match: { action: "commit" } });
          const completion = dialog.locator("openclaw-modal-actions").getByRole("button", {
            name: published ? "Done" : "Close",
            exact: true,
          });
          await completion.waitFor();
          const glyphSizes = await dialog
            .locator("svg")
            .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
          expect.soft(glyphSizes.every((size) => size <= 32)).toBe(true);
          if (!published) {
            const warning = "Remote access is not connected yet. This claw will keep trying.";
            await dialog.getByRole("button", { name: warning, exact: true }).click();
            await dialog.getByText(warning, { exact: true }).waitFor();
          }
          await completion.scrollIntoViewIfNeeded();
          expect(
            await completion.evaluate((element) => {
              const box = element.getBoundingClientRect();
              return (
                box.top >= 0 &&
                box.bottom <= innerHeight &&
                element.contains(
                  document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
                )
              );
            }),
          ).toBe(true);
          await completion.click();
          await dialog.waitFor({ state: "hidden" });
        },
      );
    }
  });

  it("uses one accessible sign-in button and contains signed-in multiline rows", async () => {
    for (const width of [1280, 390]) {
      for (const colorScheme of ["light", "dark"] as const) {
        for (const signedIn of [false, true]) {
          await suite.withPage(
            {
              ...createControlUiE2eContextOptions(),
              viewport: { width, height: width === 390 ? 360 : 844 },
              colorScheme,
              hasTouch: width === 390,
              permissions: ["clipboard-read", "clipboard-write"],
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
                    accountSignIn: "popup",
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
              let publication: OpenClawIdPublication = {
                state: "published",
                ownerAccountId: "fixture-owner",
                snapshotSeq: 1,
              };
              const gateway = await installMockGateway(page, scenario, {
                requestHandlers: {
                  "openclawId.people": () => ({
                    link: { ...scenario.methodResponses["openclawId.status"].link, publication },
                  }),
                },
              });
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
                ? menu.getByRole("menuitem", { name: "Copy claw link", exact: true })
                : menu.locator('[data-value="openclaw-id:sign-in"]');
              await target.hover();
              if (width === 1280) {
                await expect
                  .poll(() => target.evaluate((node) => getComputedStyle(node).backgroundColor))
                  .toMatch(/\/ 0\.08\)$/);
              }
              await page.evaluate(() => document.fonts.ready);
              const geometry = await menu.evaluate((element) =>
                [
                  ...element.querySelectorAll(
                    ".sidebar-customize-menu__item, .sidebar-openclaw-id__status, .sidebar-openclaw-id__linked",
                  ),
                ].map((row) => {
                  const rect = row.getBoundingClientRect();
                  const card = row.closest(".sidebar-openclaw-id__card")?.getBoundingClientRect();
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
                    cardBottom: card?.bottom,
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
                if (row.cardBottom !== undefined) {
                  expect.soft(row.bottom, row.text ?? "row").toBeLessThanOrEqual(row.cardBottom);
                }
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
                  .toBe(2);
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
                  await menu
                    .getByRole("menuitem", { name: "Connect a device", exact: true })
                    .focus();
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
                const card = menu.getByRole("menuitem", { name: "Copy claw link", exact: true });
                const box = await card.boundingBox();
                expect(box?.height).toBe(56);
                const opacity = (selector: string) =>
                  card.locator(selector).evaluate((node) => getComputedStyle(node).opacity);
                await expect.poll(() => opacity(".sidebar-openclaw-id__copy")).toBe("1");
                await expect
                  .poll(() => opacity(".sidebar-openclaw-id__pill"))
                  .toBe(width === 390 ? "1" : "0");
                expect(await card.locator(".sidebar-openclaw-id__copy > span").count()).toBe(2);
                const copyIcon = await card.locator(".sidebar-openclaw-id__copy-a").elementHandle();
                expect(
                  await card.locator(".sidebar-openclaw-id__copy-b").evaluate((node) => ({
                    opacity: getComputedStyle(node).opacity,
                    scale: getComputedStyle(node).scale,
                    transition: getComputedStyle(node).transition,
                  })),
                ).toEqual({
                  opacity: "0",
                  scale: "0.6",
                  transition: "opacity 0.16s, scale 0.2s cubic-bezier(0.2, 0.8, 0.2, 1)",
                });
                // Activate the radio/label row, not just the address, then use the keyboard.
                await card.click({ position: { x: 10, y: 10 } });
                await expect.poll(() => card.getAttribute("data-copied")).toBe("true");
                expect(await copyIcon?.evaluate((node) => node.isConnected)).toBe(true);
                await expect.poll(() => opacity(".sidebar-openclaw-id__copy-b")).toBe("1");
                expect(await opacity(".sidebar-openclaw-id__copy-a")).toBe("0");
                expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
                  "https://a-long-demo-claw-e61zr.crabd.xyz",
                );
                expect(await card.boundingBox()).toEqual(box);
                await page.evaluate(() => navigator.clipboard.writeText(""));
                await card.focus();
                await page.keyboard.press("Enter");
                await expect
                  .poll(() => page.evaluate(() => navigator.clipboard.readText()))
                  .toBe("https://a-long-demo-claw-e61zr.crabd.xyz");
                expect(await menu.isVisible()).toBe(true);
                expect(await card.getAttribute("aria-label")).toBe("Copy claw link");
                expect
                  .soft(
                    await menu.getByRole("menuitem", { name: "Your devices", exact: true }).count(),
                  )
                  .toBe(1);
                // Server publication events change the open menu through its real subscription.
                await page.setViewportSize({ width, height: 900 });
                for (const reducedMotion of ["no-preference", "reduce"] as const) {
                  await page.emulateMedia({ reducedMotion });
                  const before = await menu.boundingBox();
                  const motion =
                    reducedMotion === "no-preference"
                      ? page.waitForFunction(() => {
                          const surface = document.querySelector(".sidebar-identity-menu");
                          const height = surface
                            ?.getAnimations()
                            .find(
                              (animation) =>
                                animation.effect instanceof KeyframeEffect &&
                                animation.effect.getKeyframes().some((frame) => "height" in frame),
                            );
                          if (!height) {
                            return null;
                          }
                          return surface
                            ?.getAnimations({ subtree: true })
                            .filter(
                              (animation) =>
                                animation instanceof Animation &&
                                !(animation instanceof CSSTransition) &&
                                !(animation instanceof CSSAnimation),
                            )
                            .map((animation) => ({
                              timing: animation.effect?.getTiming(),
                              frames:
                                animation.effect instanceof KeyframeEffect
                                  ? animation.effect.getKeyframes()
                                  : [],
                            }));
                        })
                      : null;
                  publication = {
                    state: "failed",
                    code: "needs_link_code",
                    message: "Synthetic publication warning",
                  };
                  await gateway.emitGatewayEvent("openclawId.people.changed", {});
                  await menu
                    .getByRole("menuitem", { name: "Publish new keys", exact: true })
                    .waitFor();
                  if (motion) {
                    const animations = await (await motion).jsonValue();
                    expect(animations).toEqual(
                      expect.arrayContaining([
                        expect.objectContaining({
                          timing: expect.objectContaining({
                            duration: 240,
                            easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
                          }),
                        }),
                        expect.objectContaining({
                          timing: expect.objectContaining({
                            duration: 220,
                            delay: 80,
                            fill: "backwards",
                          }),
                          frames: expect.arrayContaining([
                            expect.objectContaining({ opacity: "0" }),
                            expect.objectContaining({ opacity: "1" }),
                          ]),
                        }),
                      ]),
                    );
                  }
                  await expect
                    .poll(() =>
                      menu.evaluate(
                        (node) =>
                          node
                            .getAnimations({ subtree: true })
                            .filter(
                              (animation) => animation.playState === "running" || animation.pending,
                            ).length,
                      ),
                    )
                    .toBe(0);
                  const after = await menu.boundingBox();
                  expect(after!.height).toBeGreaterThan(before!.height);
                  expect(after!.width).toBe(before!.width);
                  expect(after!.x).toBe(before!.x);
                  expect(after!.y + after!.height).toBeCloseTo(before!.y + before!.height, 1);
                  expect(await card.evaluate((node) => node === document.activeElement)).toBe(true);
                  expect(await menu.evaluate((node) => node.style.overflow)).toBe("");
                  if (reducedMotion === "reduce") {
                    expect(
                      await card.evaluate((node) => getComputedStyle(node).transitionDuration),
                    ).toBe("1e-05s");
                    // Copy feedback can restart the permitted 0.01 ms CSS transitions.
                    for (const timing of await menu.evaluate((node) =>
                      node
                        .getAnimations({ subtree: true })
                        .map((animation) => animation.effect?.getComputedTiming()),
                    )) {
                      expect(timing?.duration).toBeLessThanOrEqual(0.01);
                      expect(timing?.delay).toBeLessThanOrEqual(0.01);
                    }
                  }
                  publication = {
                    state: "published",
                    ownerAccountId: "fixture-owner",
                    snapshotSeq: 2,
                  };
                  await gateway.emitGatewayEvent("openclawId.people.changed", {});
                  await menu
                    .getByRole("menuitem", { name: "Publish new keys", exact: true })
                    .waitFor({ state: "hidden" });
                  await expect
                    .poll(async () => (await menu.boundingBox())?.height)
                    .toBe(before!.height);
                }
              }
            },
          );
        }
      }
    }
  });
});
