import { createServer, type ViteDevServer } from "vite";
import { expect, it } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { setDisplayName } from "../../../src/state/user-profile-writes.worker.ts";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { requireString } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { deviceGatewayEnv } from "./device-gateway.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI profile page real Gateway E2E",
  startServerBeforeBrowser: true,
});

const authenticatedUser = "primary.user@example.test";

suite.define(() => {
  it("shows the authenticated user instead of the default agent through a real Gateway", async () => {
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
              heartbeat: { agentId: "clipper" },
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
        proxy = await createServer({
          configFile: false,
          envFile: false,
          root: state.workspaceDir,
          appType: "custom",
          logLevel: "error",
          server: {
            host: "127.0.0.1",
            port: 0,
            proxy: {
              "/": {
                target: `http://127.0.0.1:${port}`,
                ws: true,
                headers: {
                  "x-forwarded-for": "192.0.2.10",
                  "x-forwarded-proto": "http",
                  "x-forwarded-user": authenticatedUser,
                },
              },
            },
          },
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
            await nameInput.fill("");
            await nameInput.press("Enter");
            await text(".profile-hero__name").toBe(authenticatedUser);
            await expect.poll(() => draft.inputValue()).toBe("Local draft");

            const channelIdentity = {
              channelId: "synthetic-e2e-channel",
              accountId: "synthetic-e2e-account",
              senderId: "synthetic-e2e-sender",
            };
            const identitySection = page.locator("#settings-profile-channel-identities");
            const identityRow = identitySection
              .locator(".settings-row")
              .filter({ hasText: channelIdentity.senderId });
            const expectIdentitySectionInFrame = async (
              contentSelector: string,
              contentText: string,
            ) => {
              const heading = identitySection.locator(".settings-section__heading");
              const content = identitySection
                .locator(contentSelector)
                .filter({ hasText: contentText });
              await expect.poll(() => heading.textContent()).toContain("Linked channel accounts");
              await expect.poll(() => content.count()).toBe(1);
              await content.evaluate((element) => element.scrollIntoView({ block: "center" }));
              const [headingBox, contentBox] = await Promise.all([
                heading.boundingBox(),
                content.boundingBox(),
              ]);
              const viewport = page.viewportSize();
              expect(viewport).not.toBeNull();
              expect(headingBox).not.toBeNull();
              expect(contentBox).not.toBeNull();
              expect(headingBox!.y).toBeGreaterThanOrEqual(0);
              expect(headingBox!.y + headingBox!.height).toBeLessThanOrEqual(viewport!.height);
              expect(contentBox!.y).toBeGreaterThanOrEqual(0);
              expect(contentBox!.y + contentBox!.height).toBeLessThanOrEqual(viewport!.height);
            };

            for (const [label, value] of [
              ["Channel ID", channelIdentity.channelId],
              ["Configured account ID", channelIdentity.accountId],
              ["Native sender ID", channelIdentity.senderId],
            ] as const) {
              await identitySection.getByRole("textbox", { name: label, exact: true }).fill(value);
            }
            await identitySection.getByRole("button", { name: "Add link", exact: true }).click();
            await expect
              .poll(() => identitySection.locator('[role="status"]').textContent())
              .toContain("Channel account link added.");
            await expect.poll(() => identityRow.count()).toBe(1);
            await expect.poll(() => identityRow.textContent()).toContain(channelIdentity.senderId);
            await expectIdentitySectionInFrame(".settings-row", channelIdentity.senderId);

            const reloadWithLink = await page.reload();
            expect(reloadWithLink?.status()).toBe(200);
            await expect
              .poll(() => page.locator(".profile-hero__handle").textContent())
              .toContain(authenticatedUser);
            await expect.poll(() => identityRow.count()).toBe(1);
            await expect.poll(() => identityRow.textContent()).toContain(channelIdentity.senderId);
            await expectIdentitySectionInFrame(".settings-row", channelIdentity.senderId);

            await identitySection
              .getByRole("button", {
                name: `Remove link ${channelIdentity.channelId}, ${channelIdentity.accountId}, ${channelIdentity.senderId}`,
                exact: true,
              })
              .click();
            await expect
              .poll(() => identitySection.locator('[role="status"]').textContent())
              .toContain("Channel account link removed.");
            await expect
              .poll(() => identitySection.locator(".settings-empty").textContent())
              .toContain("No channel accounts are linked to your profile.");

            const reloadWithoutLink = await page.reload();
            expect(reloadWithoutLink?.status()).toBe(200);
            await expect
              .poll(() => page.locator(".profile-hero__handle").textContent())
              .toContain(authenticatedUser);
            await expect.poll(() => identityRow.count()).toBe(0);
            await expect
              .poll(() => identitySection.locator(".settings-empty").textContent())
              .toContain("No channel accounts are linked to your profile.");
            await expectIdentitySectionInFrame(
              ".settings-empty",
              "No channel accounts are linked to your profile.",
            );
          },
        );
      },
      () => proxy?.close(),
      () => gateway?.close({ reason: "profile real Gateway e2e cleanup" }),
      () => state.cleanup(),
    );
  });
});
