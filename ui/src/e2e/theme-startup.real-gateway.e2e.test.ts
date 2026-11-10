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
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { deviceGatewayEnv } from "./device-gateway-env.test-support.ts";
import { createGatewayProxy, gatewayProxyRoute } from "./gateway-proxy.test-support.ts";

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
      },
      () => client?.stopAndWait(),
      () => proxy?.close(),
      () => gateway?.close({ reason: "theme startup proof cleanup" }),
      () => state.cleanup(),
    );
  });
});
