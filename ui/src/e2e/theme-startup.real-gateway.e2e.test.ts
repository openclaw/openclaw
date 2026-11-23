import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ViteDevServer } from "vite";
import { expect, it } from "vitest";
import { gatewayOriginScope } from "../../../packages/gateway-client/src/gateway-origin-scope.ts";
import type { GatewayClient } from "../../../src/gateway/client.ts";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { loadOrCreateDeviceIdentity } from "../../../src/infra/device-identity.ts";
import { setUserProfileRole } from "../../../src/state/user-profile-writes.worker.ts";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { acquireGatewayTestClient } from "../../../test/helpers/gateway-client.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import type { ShellGatewayOwner } from "../app/app-shell-gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { deviceGatewayEnv } from "./device-gateway-env.test-support.ts";
import { createGatewayProxy, gatewayProxyRoute } from "./gateway-proxy.test-support.ts";

type OverlapDriver = {
  app: Pick<ApplicationContext, "gateway" | "theme" | "runtimeConfig">;
  owner: ShellGatewayOwner;
  ready: Promise<void>;
  held: boolean;
  reads: number;
  installGate(): void;
  release(): void;
  stop(): void;
};

const suite = createControlUiE2eSuite({
  name: "Saved appearance after real Gateway startup",
  startServerBeforeBrowser: true,
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});

suite.define(() => {
  it("restores a saved profile over a stale mirror even when the last-seen snapshot matches", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "theme-startup",
      env: {
        ...deviceGatewayEnv,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
      },
    });
    let gateway: GatewayServer | undefined;
    let client: GatewayClient | undefined;
    let proxy: ViteDevServer | undefined;
    await runQaGatewayFixture(
      async () => {
        const user = "theme-reader@example.test";
        const profile = ensureProfileForEmail(user);
        setUserProfileRole(profile.id, "administrator");
        const origin = new URL(suite.server.baseUrl).origin;
        const trustedProxy = {
          allowLoopback: true,
          allowUsers: [user],
          deviceAutoApprove: { enabled: true, scopes: ["operator.read", "operator.write"] },
          requiredHeaders: ["x-forwarded-proto"],
          userHeader: "x-forwarded-user",
        };
        await state.writeConfig({
          agents: { entries: { main: { name: "Theme proof", workspace: state.workspaceDir } } },
          gateway: {
            auth: {
              mode: "trusted-proxy",
              trustedProxy,
              identityScopes: { [user]: ["operator.admin"] },
            },
            controlUi: { allowedOrigins: [origin], enabled: false },
            port,
            trustedProxies: ["127.0.0.1", "::1"],
          },
        });
        const { startGatewayServer } = await import("../../../src/gateway/server.js");
        gateway = await startGatewayServer(port, {
          auth: { mode: "trusted-proxy", trustedProxy },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        proxy = await createGatewayProxy(state.workspaceDir, {
          "/": gatewayProxyRoute(port, user),
        });
        await proxy.listen();
        const proxyUrl = proxy.resolvedUrls?.local[0];
        if (!proxyUrl) {
          throw new Error("Theme proof proxy did not start");
        }
        const gatewayUrl = new URL(proxyUrl);
        gatewayUrl.protocol = "ws:";
        client = await acquireGatewayTestClient(
          {
            url: gatewayUrl.href,
            origin,
            clientName: "openclaw-control-ui",
            mode: "webchat",
            role: "operator",
            scopes: ["operator.read", "operator.write"],
            sharedStateMode: "read-only",
            deviceIdentity: loadOrCreateDeviceIdentity({
              env: state.env,
              identityKey: "theme-proof",
            }),
          },
          {
            timeoutMs: 15_000,
            timeoutMessage: "Theme proof client did not connect",
            closeMessage: "Theme proof client closed",
          },
        );
        expect(
          await client.request("users.prefs.set", {
            entries: { "ui.theme": "knot", "ui.themeMode": "dark" },
          }),
        ).toMatchObject({ status: "ok" });
        // Exercise the generation overlap with genuine server responses. Only delivery
        // timing is controlled: no preference/catalog response is manufactured.
        await suite.withPage(
          { serviceWorkers: "block", permissions: ["local-network-access"] },
          async ({ page }) => {
            await page.route("**/theme-owner-proof", (route) =>
              route.fulfill({
                contentType: "text/html",
                body: "<!doctype html><html><body></body></html>",
              }),
            );
            await page.goto(new URL("theme-owner-proof", suite.server.baseUrl).href);
            const driver = await page.evaluateHandle<OverlapDriver>(`(async () => {
            // Source-server imports use the same production modules as the shell.
            const modules = await Promise.all([
              import("/src/app/gateway-store.ts"), import("/src/app/bootstrap-theme.ts"),
              import("/src/lib/config/runtime-config-capability.ts"), import("/src/app/settings.ts"),
              import("/src/app/app-shell-gateway.ts"),
            ]);
            const [{ createApplicationGateway }, { createApplicationTheme }, { createRuntimeConfigCapability }, { loadSettings }, { ShellGatewayOwner }] = modules;
            const settings = { ...loadSettings(), gatewayUrl: ${JSON.stringify(gatewayUrl.href)}, theme: "claw", themeMode: "system" };
            const gateway = createApplicationGateway(settings);
            const theme = createApplicationTheme(settings, gateway);
            const runtimeConfig = createRuntimeConfigCapability(gateway);
            const app = { gateway, theme, runtimeConfig };
            const owner = new ShellGatewayOwner({
              context: app,
              activeSessionKey: "",
              lastLocalePrefSignature: null,
              routeState: {},
              invalidate() {},
              outboxStoreImport: { load: async () => undefined },
              shellNavigation: { recoverDeletedActiveSession() {} },
            });
            const stop = app.gateway.subscribeEvents((event) => {
              if (event.event === "users.prefs.changed") owner.handleGatewayEvent(event);
            });
            gateway.start();
            return {
              app,
              owner,
              ready: Promise.resolve(),
              held: false,
              reads: 0,
              release() {},
              installGate() {
                const driver = this;
                const client = gateway.snapshot.client;
                const request = client.request.bind(client);
                let resolve;
                const gate = new Promise(r => { resolve = r; });
                driver.release = resolve;
                client.request = async (method, ...args) => {
                  const response = await request(method, ...args);
                  if (method === "users.prefs.get") {
                    driver.reads++;
                    if (!driver.held) { driver.held = true; await gate; }
                  }
                  return response;
                };
              },
              stop: () => {
                stop();
                owner.reset();
                runtimeConfig.dispose(); theme.dispose(); gateway.stop();
              },
            };
          })()`);
            try {
              await expect
                .poll(
                  () =>
                    driver.evaluate(({ app }) => ({
                      url: app.gateway.connection.gatewayUrl,
                      phase: app.gateway.snapshot.phase,
                      error: app.gateway.snapshot.lastError,
                    })),
                  { timeout: 15000 },
                )
                .toEqual({ url: gatewayUrl.href, phase: "connected", error: null });
              await expect
                .poll(() => driver.evaluate(({ app }) => app.gateway.snapshot.selfUser?.id))
                .toBe(profile.id);
              await driver.evaluate((probe) => probe.installGate());
              await client!.request("users.prefs.set", {
                entries: { "ui.theme": "knot", "ui.themeMode": "dark" },
              });
              await expect.poll(() => driver.evaluate(({ held }) => held)).toBe(true);
              // The event-triggered read is now in flight when config admission
              // advances the generation. This is the distinct regression boundary.
              await driver.evaluate((probe) => {
                probe.ready = probe.owner.ensureRuntimeConfig(
                  probe.app.gateway.snapshot,
                  probe.app.runtimeConfig,
                );
              });
              await driver.evaluate((probe) => probe.release());
              await driver.evaluate((probe) => probe.ready);
              expect(await driver.evaluate(({ app }) => app.theme.settings.theme)).toBe("knot");
              await expect
                .poll(() => page.locator("html").getAttribute("data-theme"))
                .toBe("openknot");
              await writeFile(
                path.join(suite.artifactDir, "generation-overlap.json"),
                JSON.stringify(
                  {
                    transport: "real Gateway WebSocket",
                    heldPreferenceResponse: await driver.evaluate(({ held }) => held),
                    preferenceRequests: await driver.evaluate(({ reads }) => reads),
                    theme: await driver.evaluate(({ app }) => app.theme.settings.theme),
                  },
                  null,
                  2,
                ),
              );
            } finally {
              await driver.evaluate((probe) => probe.release());
              await driver.evaluate((probe) => probe.stop());
              await driver.dispose();
            }
          },
        );
        // A clean browser has no settings record or last-seen profile mirror.
        await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
          const url = new URL("settings/appearance", suite.server.baseUrl);
          url.hash = new URLSearchParams({ gatewayUrl: gatewayUrl.href }).toString();
          await page.goto(url.href);
          await page
            .locator("openclaw-gateway-url-confirmation")
            .getByRole("button", { name: `Switch to ${gatewayUrl.host}`, exact: true })
            .click();
          await waitForControlUiGatewayReady(page);
          await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("openknot");
          console.log("[theme-proof] clean browser restored authenticated Knot/dark");
        });
        await suite.withPage(
          { colorScheme: "light", viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
          async ({ page }) => {
            await page.addInitScript(
              ({ url, scope, profileId }) => {
                if (sessionStorage.getItem("theme-proof-seeded")) {
                  return;
                }
                sessionStorage.setItem("theme-proof-seeded", "1");
                localStorage.setItem(
                  `openclaw.control.settings.v1:${scope}`,
                  JSON.stringify({ gatewayUrl: url, theme: "claw", themeMode: "system" }),
                );
                localStorage.setItem(
                  `openclaw.control.serverPrefs.v1:${url}:profile:${profileId}`,
                  JSON.stringify({ theme: "knot", themeMode: "dark" }),
                );
              },
              {
                url: gatewayUrl.href,
                scope: gatewayOriginScope(gatewayUrl.href),
                profileId: profile.id,
              },
            );
            const url = new URL("settings/appearance", suite.server.baseUrl);
            url.hash = new URLSearchParams({ gatewayUrl: gatewayUrl.href }).toString();
            await page.goto(url.href);
            await page
              .locator("openclaw-gateway-url-confirmation")
              .getByRole("button", { name: `Switch to ${gatewayUrl.host}`, exact: true })
              .click();
            await waitForControlUiGatewayReady(page);
            const read = () =>
              evaluateControlUiContext(page, (app) => ({
                profileId: app.gateway.snapshot.selfUser?.id,
                theme: app.theme.settings.theme,
                mode: app.theme.settings.themeMode,
              }));
            for (const reload of [false, true]) {
              if (reload) {
                await page.reload();
                await waitForControlUiGatewayReady(page);
              }
              try {
                await expect
                  .poll(read)
                  .toEqual({ profileId: profile.id, theme: "knot", mode: "dark" });
                await expect
                  .poll(() => page.locator("html").getAttribute("data-theme"))
                  .toBe("openknot");
                await expect
                  .poll(() => page.locator(".settings-theme-card--knot").getAttribute("class"))
                  .toContain("settings-theme-card--active");
              } finally {
                const surface = page.locator("openclaw-app");
                const frame = await takeControlUiScreenshotFrame(
                  page,
                  surface,
                  [page.locator(".settings-theme-card--claw")],
                  { animations: "disabled" },
                );
                await writeFile(
                  path.join(suite.artifactDir, reload ? "reload.png" : "startup.png"),
                  frame.png,
                );
              }
            }
          },
        );
        // Native retargeting must preserve the target mirror before server hydration.
        await suite.withPage(
          { colorScheme: "light", viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
          async ({ page }) => {
            await page.addInitScript(
              ({ url, scope }) => {
                window["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = { gatewayUrl: url, token: null };
                const previous = `ws://${location.host}`;
                localStorage.setItem(`openclaw.control.currentGateway.v1:${previous}`, previous);
                localStorage.setItem(
                  `openclaw.control.settings.v1:${previous}`,
                  JSON.stringify({ gatewayUrl: previous, theme: "claw", themeMode: "system" }),
                );
                localStorage.setItem(
                  `openclaw.control.settings.v1:${scope}`,
                  // v2026.11.4 settings.ts writes these fields under the same v1 key.
                  JSON.stringify({
                    gatewayUrl: url,
                    theme: "knot",
                    themeMode: "dark",
                    navWidth: 310,
                    locale: "en",
                  }),
                );
              },
              { url: gatewayUrl.href, scope: gatewayOriginScope(gatewayUrl.href) },
            );
            let connect = () => {};
            await page.routeWebSocket(gatewayUrl.href, (socket) => {
              connect = () => {
                socket.connectToServer();
              };
            });
            await page.goto(new URL("settings/appearance", suite.server.baseUrl).href);
            try {
              await expect
                .poll(() =>
                  evaluateControlUiContext(page, (app) => app.gateway.connection.gatewayUrl),
                )
                .toBe(gatewayUrl.href);
              const frame = await takeControlUiScreenshotFrame(
                page,
                page.locator("openclaw-app"),
                [],
                { animations: "disabled" },
              );
              await writeFile(
                path.join(suite.artifactDir, "native-before-hydration.png"),
                frame.png,
              );
              expect(
                await page.evaluate(
                  (scope) =>
                    JSON.parse(
                      localStorage.getItem(`openclaw.control.settings.v1:${scope}`) ?? "{}",
                    ),
                  gatewayOriginScope(gatewayUrl.href),
                ),
              ).toMatchObject({ theme: "knot", themeMode: "dark", navWidth: 310, locale: "en" });
              expect(
                await evaluateControlUiContext(page, (app) => ({
                  theme: app.theme.settings.theme,
                  themeMode: app.theme.settings.themeMode,
                  navWidth: app.theme.settings.navWidth,
                  locale: app.theme.settings.locale,
                })),
              ).toEqual({ theme: "knot", themeMode: "dark", navWidth: 310, locale: "en" });
              console.log(
                "[theme-proof] v2026.11.4-format v1 record retained theme, mode, width and locale before hydration",
              );
            } finally {
              connect();
            }
            await waitForControlUiGatewayReady(page);
            await expect
              .poll(() => page.locator("html").getAttribute("data-theme"))
              .toBe("openknot");
          },
        );
      },
      () => client?.stopAndWait(),
      () => proxy?.close(),
      () => gateway?.close({ reason: "theme startup proof cleanup" }),
      () => state.cleanup(),
    );
  });
});
