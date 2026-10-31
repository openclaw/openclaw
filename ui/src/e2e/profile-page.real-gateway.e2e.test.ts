import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ViteDevServer } from "vite";
import { expect, it } from "vitest";
import type { GatewayClient } from "../../../src/gateway/client.ts";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { loadOrCreateDeviceIdentity } from "../../../src/infra/device-identity.ts";
import {
  setDisplayName,
  setUserProfileRole,
} from "../../../src/state/user-profile-writes.worker.ts";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { acquireGatewayTestClient } from "../../../test/helpers/gateway-client.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { requireString } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { deviceGatewayEnv } from "./device-gateway-env.test-support.ts";
import { createGatewayProxy, gatewayProxyRoute } from "./gateway-proxy.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI profile page real Gateway E2E",
  startServerBeforeBrowser: true,
});

const authenticatedUser = "primary.user@example.test";
const administrator = "administrator@example.test";

suite.define(() => {
  it("lets a guest edit their profile and request admin after real role promotion", async () => {
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
    let admin: GatewayClient | undefined;
    let proxy: ViteDevServer | undefined;
    await runQaGatewayFixture(
      async () => {
        const guest = ensureProfileForEmail(authenticatedUser);
        setDisplayName(guest.id, "Test Person");
        setUserProfileRole(ensureProfileForEmail(administrator).id, "administrator");
        const origin = new URL(suite.server.baseUrl).origin;
        const trustedProxy = {
          allowLoopback: true,
          allowUsers: [authenticatedUser, administrator],
          deviceAutoApprove: {
            enabled: true,
            scopes: ["operator.read", "operator.write"],
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
            auth: {
              mode: "trusted-proxy",
              trustedProxy,
              identityScopes: { [administrator]: ["operator.admin"] },
            },
            controlUi: { allowedOrigins: [origin], enabled: false },
            port,
            trustedProxies: ["127.0.0.1", "::1"],
            roles: {
              default: "guest",
              definitions: {
                guest: {
                  agents: "*",
                  sessions: { others: "view" },
                  scopes: ["operator.sessions.write"],
                },
                administrator: {
                  agents: "*",
                  sessions: { others: "write" },
                  scopes: ["operator.admin"],
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
          "/admin": {
            ...gatewayProxyRoute(port, administrator, "192.0.2.11"),
            rewrite: () => "/",
          },
          "/": gatewayProxyRoute(port, authenticatedUser),
        });
        await proxy.listen();
        const gatewayUrl = new URL(
          requireString(proxy.resolvedUrls?.local[0], "profile proxy URL"),
        );
        gatewayUrl.protocol = "ws:";
        admin = await acquireGatewayTestClient(
          {
            url: new URL("admin", gatewayUrl).href,
            origin,
            clientName: "openclaw-control-ui",
            mode: "webchat",
            role: "operator",
            scopes: ["operator.read"],
            sharedStateMode: "read-only",
            deviceIdentity: loadOrCreateDeviceIdentity({
              env: state.env,
              identityKey: "proof-admin",
            }),
            onHelloOk: (hello) => expect(hello.auth?.scopes).toContain("operator.admin"),
          },
          {
            timeoutMs: 15_000,
            timeoutMessage: "Proof administrator did not connect",
            closeMessage: "Proof administrator closed before hello",
          },
        );
        const adminClient = admin;

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
            const capture = async (name: string, selector: string) => {
              if (!process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
                return;
              }
              const surface = page.locator(selector);
              const frame = await takeControlUiScreenshotFrame(page, surface, [surface], {
                animations: "disabled",
                scrollTo: surface,
              });
              await writeFile(path.join(suite.artifactDir, name), frame.png);
            };
            await text(".profile-hero__name").toBe("Test Person");
            await page.locator("#personal-instructions-content:enabled").waitFor();
            await capture("guest-profile.png", "#settings-profile-access");
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
            await editor.close();
            const auth = () =>
              evaluateControlUiContext(page, (app) => ({
                scopes: app.gateway.snapshot.hello?.auth?.scopes,
                sessionCap: app.gateway.snapshot.hello?.auth?.sessionCap,
                roleAllowsAdmin: app.gateway.snapshot.hello?.auth?.roleAllowsAdmin,
              }));
            const guestAuth = await auth();
            expect(guestAuth).toMatchObject({
              scopes: ["operator.sessions.write"],
              sessionCap: "view",
              roleAllowsAdmin: false,
            });
            await page.goto(new URL("new", suite.server.baseUrl).href);
            await waitForControlUiGatewayReady(page);
            await expect.poll(auth).toEqual(guestAuth);
            const inbox = page.locator(".sidebar-issues-button:visible");
            await inbox.click();
            const panel = page.locator("#sidebar-issues-panel");
            await panel.getByRole("tab", { name: /System/u }).click();
            await capture("guest-inbox.png", "#sidebar-issues-panel");
            await expect.poll(() => inbox.getAttribute("aria-label")).toBe("0 inbox items");
            expect(await panel.locator('[data-attention-kind="scopeUpgrade"]').count()).toBe(0);
            expect(await page.locator(".sidebar-issues-button__count").count()).toBe(0);
            await page.goto(new URL("settings/profile", suite.server.baseUrl).href);
            const access = page.locator("#settings-profile-access");
            await access
              .getByText(
                "Your role limits access. Device approval cannot grant administrator access. If you need more access, ask a Gateway administrator to change your role, then reconnect.",
                { exact: true },
              )
              .waitFor();
            expect(
              await access.getByRole("button", { name: "Request admin", exact: true }).count(),
            ).toBe(0);
            const listPairing = () =>
              adminClient.request<{ pending: Array<{ requestId: string; scopes?: string[] }> }>(
                "device.pair.list",
                {},
              );
            expect((await listPairing()).pending).toHaveLength(0);
            const promoted = await adminClient.request<{ profile: { role: string } }>(
              "users.setRole",
              {
                profileId: guest.id,
                role: "administrator",
              },
            );
            expect(promoted.profile.role).toBe("administrator");
            await expect.poll(auth).toMatchObject({ sessionCap: "write", roleAllowsAdmin: true });
            const promotedAuth = await auth();
            expect(promotedAuth.scopes).not.toContain("operator.admin");
            await page.locator("#personal-instructions-content:enabled").waitFor();
            await capture("promoted-profile.png", "#settings-profile-access");
            await access.getByRole("button", { name: "Request admin", exact: true }).click();
            await access.getByText(/Approve this browser by running/u).waitFor();
            const pending = (await listPairing()).pending;
            expect(pending).toHaveLength(1);
            expect(pending[0]?.scopes).toContain("operator.admin");
            expect((await auth()).scopes).not.toContain("operator.admin");
            await adminClient.request("device.pair.approve", { requestId: pending[0]!.requestId });
            await access
              .getByText("You have permission to manage this server.", { exact: true })
              .waitFor();
            expect((await auth()).scopes).toContain("operator.admin");
            await page.reload();
            await access
              .getByText("You have permission to manage this server.", { exact: true })
              .waitFor();
            const reloadedAuth = await auth();
            expect(reloadedAuth.scopes).toContain("operator.admin");
            expect(
              await access.getByRole("button", { name: "Request admin", exact: true }).count(),
            ).toBe(0);
            expect((await listPairing()).pending).toHaveLength(0);
            await writeFile(
              path.join(suite.artifactDir, "guest-access-real.json"),
              JSON.stringify(
                {
                  transport:
                    "real Gateway and browser through synthetic trusted proxy; no mocked RPCs",
                  deviceAutoApprovalScopes: trustedProxy.deviceAutoApprove.scopes,
                  guestAuth,
                  guestRequest: "role guidance with no request action; no pending approval created",
                  promotedRole: promoted.profile.role,
                  promotedAuth,
                  pendingApprovalScopes: pending[0]?.scopes,
                  reloadedAuth,
                },
                null,
                2,
              ),
            );
          },
        );
      },
      () => admin?.stopAndWait(),
      () => proxy?.close(),
      () => gateway?.close({ reason: "profile real Gateway e2e cleanup" }),
      () => state.cleanup(),
    );
  });
});
