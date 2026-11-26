import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.js";
import type { ModelAuthStatusResult } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.js";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.js";
import { expandProvider } from "./model-providers.test-support.ts";

const profileId = "acme:user@example.com";
let instance: OpenClawTestInstance;
let revokeServer: Server;
let revokeStatus = 503;
const revokeRequests: Array<{
  method?: string;
  contentType?: string;
  dpop: boolean;
  body: string;
}> = [];
let artifactDir: string;

const suite = createControlUiE2eSuite({
  name: "Provider sign-out and disconnect through a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    artifactDir = createControlUiE2eArtifactDir("model-provider-disconnect");
    revokeServer = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        revokeRequests.push({
          method: request.method,
          contentType: request.headers["content-type"],
          dpop: request.headers.dpop !== undefined,
          body,
        });
        response.writeHead(revokeStatus).end();
      });
    });
    revokeServer.listen(0, "127.0.0.1");
    await once(revokeServer, "listening");
    const address = revokeServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Revoke fixture did not bind TCP");
    }
    instance = await createOpenClawTestInstance({
      name: "model-provider-disconnect",
      reserveIdlePort: false,
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        VITEST: undefined,
        NODE_ENV: undefined,
      },
    });
    const pluginDir = instance.state.path("acme-plugin");
    await fs.cp(
      fileURLToPath(new URL("../../../test/fixtures/provider-account-disconnect", import.meta.url)),
      pluginDir,
      { recursive: true },
    );
    const base: OpenClawConfig = JSON.parse(await fs.readFile(instance.configPath, "utf8"));
    await instance.state.writeConfig({
      ...base,
      gateway: { ...base.gateway, controlUi: { enabled: true } },
      // The plugin owns the selected model's provider, so the Gateway loads it at startup.
      agents: { ownership: "explicit", entries: { main: {} }, defaults: { model: "acme/ready" } },
      models: { catalogRefresh: { enabled: false } },
      cron: { enabled: false },
      plugins: {
        allow: ["acme"],
        load: { paths: [pluginDir] },
        entries: {
          acme: { enabled: true, config: { origin: `http://127.0.0.1:${address.port}` } },
        },
        slots: { memory: "none" },
      },
    });
    await instance.state.writeAuthProfiles({
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "acme",
          access: "synthetic-access",
          refresh: "synthetic-refresh",
          expires: Date.now() + 86_400_000,
          email: "user@example.com",
        },
      },
    });
    const close = async () => {
      try {
        await fs.writeFile(path.join(artifactDir, "gateway.log"), instance.logs());
        await instance.cleanup();
      } finally {
        revokeServer.closeAllConnections();
        revokeServer.close();
      }
    };
    try {
      await instance.startGateway();
      return { baseUrl: `http://127.0.0.1:${instance.port}/`, close };
    } catch (error) {
      await close();
      throw error;
    }
  },
});

/** Saved acme profiles as the Gateway reports them. */
async function savedProfileIds(): Promise<string[]> {
  const result = await instance.cli([
    "gateway",
    "call",
    "models.authStatus",
    "--json",
    "--params",
    JSON.stringify({ agentId: "main" }),
  ]);
  expect(result.code, result.stderr).toBe(0);
  const status: ModelAuthStatusResult = JSON.parse(result.stdout);
  return status.providers
    .filter((provider) => provider.provider === "acme")
    .flatMap((provider) => provider.profiles.map((profile) => profile.profileId));
}

async function openAccount(page: Page) {
  // Each browser page signs in with its own one-time dashboard handoff.
  const handoff = await instance.cli(["dashboard", "--json"]);
  expect(handoff.code, handoff.stderr).toBe(0);
  const { browserUrl }: { browserUrl: string } = JSON.parse(handoff.stdout);
  const url = new URL("settings/model-providers", browserUrl);
  url.hash = new URL(browserUrl).hash;
  await page.goto(url.href);
  await waitForControlUiGatewayReady(page);
  const card = await expandProvider(page, "acme");
  const account = card.locator(`[data-profile-id="${profileId}"]`);
  await account.locator(".model-providers__profile-account-actions").waitFor();
  return { card, account };
}

suite.define(() => {
  it("keeps the sign-in when the provider refuses the revoke, then disconnects on retry", async () => {
    for (const colorScheme of ["light", "dark"] as const) {
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { width: 1280, height: 900 },
          colorScheme,
        },
        async ({ page }) => {
          const { card, account } = await openAccount(page);
          await expect
            .poll(() => account.getByRole("button").allTextContents())
            .toEqual(
              expect.arrayContaining(["Sign out on this device", "Disconnect Acme Account"]),
            );
          const manage = account.getByRole("link", { name: "Manage connected apps" });
          expect(await manage.getAttribute("href")).toBe("https://acme.example/connections");
          // Capture once the page may mutate, not while the actions are still disabled.
          await expect
            .poll(() =>
              account.getByRole("button", { name: /^Disconnect Acme Account/ }).isEnabled(),
            )
            .toBe(true);
          await card.screenshot({
            path: path.join(artifactDir, `account-actions-${colorScheme}.png`),
          });

          revokeStatus = 503;
          await account
            .getByRole("button", { name: "Disconnect Acme Account: user@example.com" })
            .click();
          const dialog = page.getByRole("dialog");
          await dialog
            .getByRole("button", { name: "Disconnect Acme Account", exact: true })
            .click();
          const toast = page
            .getByRole("alert")
            .filter({ hasText: "Couldn’t disconnect user@example.com" });
          await toast.waitFor();
          await expect
            .poll(() => toast.textContent())
            .toContain(
              "Acme could not revoke access right now (HTTP 503). The sign-in is still saved on this device.",
            );
          await toast.getByRole("button", { name: "Try again" }).waitFor();
          expect(await savedProfileIds()).toContain(profileId);
          await expect.poll(() => account.isVisible()).toBe(true);
          // Crop to the providers card and the toast above it; the rail holds operator identity.
          const box = await card.boundingBox();
          await page.screenshot({
            path: path.join(artifactDir, `revoke-failed-${colorScheme}.png`),
            clip: box
              ? { x: box.x - 16, y: 0, width: box.width + 32, height: box.y + box.height + 16 }
              : undefined,
          });

          if (colorScheme === "dark") {
            revokeStatus = 200;
            await toast.getByRole("button", { name: "Try again" }).click();
            await expect.poll(() => account.count(), { timeout: 20_000 }).toBe(0);
            await expect.poll(() => savedProfileIds()).not.toContain(profileId);
          }
        },
      );
    }

    expect(revokeRequests.length).toBe(3);
    for (const request of revokeRequests) {
      expect(request).toEqual({
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        dpop: false,
        body: "token=synthetic-refresh",
      });
    }
  });
});
