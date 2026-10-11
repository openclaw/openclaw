// Control UI proof against an isolated real Gateway and trusted user identity.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { expect, it } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { setDisplayName } from "../../../src/state/user-profile-writes.worker.ts";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { COMMUNITY_INVITE_KEY } from "../components/community-invite-state.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI profile page real Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const authenticatedUser = "primary.user@example.test";

suite.define(() => {
  it("shows the authenticated user instead of the default agent through a real Gateway", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "control-ui-profile-real-gateway",
      layout: "home",
      env: {
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    let gateway: GatewayServer | undefined;
    let proxy: ViteDevServer | undefined;
    try {
      const clipperWorkspace = state.path("workspace-clipper");
      await mkdir(clipperWorkspace, { recursive: true });
      const profile = ensureProfileForEmail(authenticatedUser);
      setDisplayName(profile.id, "Test Person");
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
            clipper: { name: "Clipper", workspace: clipperWorkspace },
          },
        },
        talk: { agentId: "clipper" },
        gateway: {
          auth: { mode: "trusted-proxy", trustedProxy },
          controlUi: {
            allowedOrigins: [new URL(suite.server.baseUrl).origin],
            enabled: false,
          },
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
      const proxyUrl = proxy.resolvedUrls?.local[0];
      if (!proxyUrl) {
        throw new Error("Profile test proxy did not expose a loopback URL");
      }
      const gatewayUrl = new URL(proxyUrl);
      gatewayUrl.protocol = "ws:";

      const proofDir = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1" ? suite.artifactDir : null;
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 800, width: 1280 },
          ...(proofDir
            ? { recordVideo: { dir: proofDir, size: { height: 800, width: 1280 } } }
            : {}),
        },
        async ({ page }) => {
          await page.addInitScript((key) => {
            window.localStorage.setItem(key, JSON.stringify({ dismissedAtMs: 1770000000000 }));
          }, COMMUNITY_INVITE_KEY);
          const url = new URL("settings/profile", suite.server.baseUrl);
          url.hash = new URLSearchParams({ gatewayUrl: gatewayUrl.href }).toString();
          const response = await page.goto(url.href);
          expect(response?.status()).toBe(200);
          const confirmation = page.locator("openclaw-gateway-url-confirmation");
          await confirmation.waitFor();
          await confirmation
            .getByRole("button", { name: `Switch to ${gatewayUrl.host}`, exact: true })
            .click();
          await expect
            .poll(() => page.locator(".profile-hero__name").textContent())
            .toBe("Test Person");
          await expect
            .poll(() => page.locator(".profile-hero__handle").textContent())
            .toContain(authenticatedUser);
          await expect
            .poll(() => page.locator(".profile-hero").textContent())
            .not.toContain("Clipper");
          if (proofDir) {
            await page.screenshot({
              animations: "disabled",
              path: path.join(proofDir, "01-real-gateway-authenticated-profile.png"),
            });
          }
          await page.locator(".identity-name-control input").fill("Local draft");
          const editor = await page.context().newPage();
          await editor.goto(new URL("settings/profile", suite.server.baseUrl).href);
          const nameInput = editor.locator(".identity-name-control input");
          await expect.poll(() => nameInput.inputValue()).toBe("Test Person");
          await nameInput.fill("Remote Person");
          await nameInput.press("Enter");
          await expect
            .poll(() => page.locator(".profile-hero__name").textContent())
            .toBe("Remote Person");
          await nameInput.fill("");
          await nameInput.press("Enter");
          await expect
            .poll(() => page.locator(".profile-hero__name").textContent())
            .toBe(authenticatedUser);
          await expect
            .poll(() => page.locator(".identity-name-control input").inputValue())
            .toBe("Local draft");
          if (proofDir) {
            await page.screenshot({
              animations: "disabled",
              path: path.join(proofDir, "02-real-gateway-cleared-profile.png"),
            });
          }

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
          if (proofDir) {
            await page.screenshot({
              animations: "disabled",
              path: path.join(proofDir, "03-real-gateway-channel-link-added.png"),
            });
          }

          const reloadWithLink = await page.reload();
          expect(reloadWithLink?.status()).toBe(200);
          await expect
            .poll(() => page.locator(".profile-hero__handle").textContent())
            .toContain(authenticatedUser);
          await expect.poll(() => identityRow.count()).toBe(1);
          await expect.poll(() => identityRow.textContent()).toContain(channelIdentity.senderId);
          await expectIdentitySectionInFrame(".settings-row", channelIdentity.senderId);
          if (proofDir) {
            await page.screenshot({
              animations: "disabled",
              path: path.join(proofDir, "04-real-gateway-channel-link-reloaded.png"),
            });
          }

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
          if (proofDir) {
            await page.screenshot({
              animations: "disabled",
              path: path.join(proofDir, "05-real-gateway-channel-link-removed-reloaded.png"),
            });
          }
        },
      );
    } finally {
      try {
        await proxy?.close();
      } finally {
        try {
          await gateway?.close({ reason: "profile real Gateway e2e cleanup" });
        } finally {
          await state.cleanup();
        }
      }
    }
  });
});
