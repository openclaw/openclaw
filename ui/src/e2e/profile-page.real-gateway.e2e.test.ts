import type { ViteDevServer } from "vite";
import { expect, it } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { setDisplayName } from "../../../src/state/user-profile-writes.worker.ts";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { requireString } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { deviceGatewayEnv } from "./device-gateway-env.test-support.ts";
import { createGatewayProxy, gatewayProxyRoute } from "./gateway-proxy.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI profile page real Gateway E2E",
  startServerBeforeBrowser: true,
});

const authenticatedUser = "primary.user@example.test";

suite.define(() => {
  it("lets a session-only member save their name and avatar through a real Gateway", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "control-ui-profile-real-gateway",
      env: {
        ...deviceGatewayEnv,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
      },
    });
    let gateway: GatewayServer | undefined;
    let proxy: ViteDevServer | undefined;
    await runQaGatewayFixture(
      async () => {
        setDisplayName(ensureProfileForEmail(authenticatedUser).id, "Test Person");
        const origin = new URL(suite.server.baseUrl).origin;
        const trustedProxy = {
          allowLoopback: true,
          allowUsers: [authenticatedUser],
          deviceAutoApprove: {
            enabled: true,
            scopes: ["operator.admin", "operator.read", "operator.write"],
          },
          requiredHeaders: ["x-forwarded-proto"],
          userHeader: "x-forwarded-user",
        };
        await state.writeConfig({
          agents: {
            ownership: "explicit",
            defaults: {
              workspace: state.workspaceDir,
              systemAgent: { agentId: "clipper" },
              authInheritance: { agentId: "clipper" },
              sessionStore: { agentId: "clipper" },
            },
            entries: {
              main: { name: "Main", workspace: state.workspaceDir },
              clipper: { name: "Clipper", workspace: state.workspaceDir },
            },
          },
          talk: { agentId: "clipper" },
          gateway: {
            auth: { mode: "trusted-proxy", trustedProxy },
            controlUi: { allowedOrigins: [origin], enabled: false },
            port,
            trustedProxies: ["127.0.0.1", "::1"],
            roles: {
              default: "member",
              definitions: {
                member: {
                  agents: "*",
                  sessions: { others: "view" },
                  scopes: ["operator.sessions.write"],
                },
              },
            },
          },
        });
        const { startGatewayServer } = await import("../../../src/gateway/server.js");
        gateway = await startGatewayServer(port, {
          auth: { mode: "trusted-proxy", trustedProxy },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });

        // Chromium does not consistently apply extraHTTPHeaders to WebSocket upgrades.
        proxy = await createGatewayProxy(state.workspaceDir, {
          "/": gatewayProxyRoute(port, authenticatedUser),
        });
        await proxy.listen();
        const gatewayUrl = new URL(
          requireString(proxy.resolvedUrls?.local[0], "profile proxy URL"),
        );
        gatewayUrl.protocol = "ws:";

        await suite.withPage(
          { locale: "en-US", serviceWorkers: "block", viewport: { height: 800, width: 1280 } },
          async ({ page }) => {
            const text = (selector: string) =>
              expect.poll(() => page.locator(selector).textContent());
            const url = new URL("settings/profile", suite.server.baseUrl);
            url.hash = new URLSearchParams({ gatewayUrl: gatewayUrl.href }).toString();
            expect((await page.goto(url.href))?.status()).toBe(200);
            const confirmation = page.locator("openclaw-gateway-url-confirmation");
            await confirmation
              .getByRole("button", { name: `Switch to ${gatewayUrl.host}`, exact: true })
              .click();
            await text(".profile-hero__name").toBe("Test Person");
            await text(".profile-hero__handle").toContain(authenticatedUser);
            await text(".profile-hero").not.toContain("Clipper");
            const draft = page.locator(".identity-name-control input");
            await draft.fill("Local draft");
            const editor = await page.context().newPage();
            await editor.goto(new URL("settings/profile", suite.server.baseUrl).href);
            const nameInput = editor.locator(".identity-name-control input");
            await expect.poll(() => nameInput.inputValue()).toBe("Test Person");
            await nameInput.fill("Remote Person");
            await nameInput.press("Enter");
            await text(".profile-hero__name").toBe("Remote Person");
            await editor.locator('#settings-profile-identity input[type="file"]').setInputFiles({
              name: "avatar.png",
              mimeType: "image/png",
              buffer: Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a6kAAAAASUVORK5CYII=",
                "base64",
              ),
            });
            const image = editor.locator(".identity-avatar-control img");
            await expect
              .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
              .toBeGreaterThan(0);
            await editor.reload();
            await expect.poll(() => nameInput.inputValue()).toBe("Remote Person");
            await expect
              .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
              .toBeGreaterThan(0);
            await nameInput.fill("");
            await nameInput.press("Enter");
            await text(".profile-hero__name").toBe(authenticatedUser);
            await expect.poll(() => draft.inputValue()).toBe("Local draft");
          },
        );
      },
      () => proxy?.close(),
      () => gateway?.close({ reason: "profile real Gateway e2e cleanup" }),
      () => state.cleanup(),
    );
  });
});
