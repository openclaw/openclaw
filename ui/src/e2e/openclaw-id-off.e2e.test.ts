import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.ts";
import type { OpenClawIdSignedIn } from "../lib/openclaw-id/types.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  controlUiSessionUrl,
  createControlUiMockBootstrapConfig,
  defaultControlUiFeatureMethods,
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { openSidebarPages } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "OpenClaw ID off-state parity" });
const sessionKey = "agent:main:off-parity";
const labTitle = "OpenClaw ID remote access";
const idCopy =
  /OpenClaw ID|Turn on remote access|Make reachable|recovery kit|Reset owner access|Approve new browser|1Password|stale-owner@example\.test/iu;
const idElements =
  '[class*="openclaw-id"], [id^="openclaw-id-"], [id^="openclaw-recovery-kit"], onepassword-save-button';

// Assert DOM and accessible names, including hidden menu/dialog leftovers, not screenshots.
async function expectNoIdUi(surface: Locator, omitLabsRow = false) {
  const content = await surface.evaluate((element, omitRow) => {
    const clone = element.cloneNode(true) as Element;
    if (omitRow) {
      for (const row of clone.querySelectorAll(".settings-row")) {
        if (
          row.querySelector(".settings-row__title")?.textContent === "OpenClaw ID remote access"
        ) {
          row.remove();
        }
      }
    }
    return {
      text: clone.textContent,
      labels: [...clone.querySelectorAll("[aria-label], [title]")].map((node) =>
        [node.getAttribute("aria-label"), node.getAttribute("title")].join(" "),
      ),
    };
  }, omitLabsRow);
  expect.soft(JSON.stringify(content)).not.toMatch(idCopy);
  expect.soft(await surface.locator(idElements).count()).toBe(0);
}

// A still-valid account left by an earlier enabled visit must not start owner notifications.
async function seedStaleAccount(page: Page) {
  const account: OpenClawIdSignedIn = {
    sub: "synthetic-stale-owner",
    email: "stale-owner@example.test",
    name: "Stale owner",
    exp: Math.floor(Date.now() / 1000) + 86_400,
    idToken: "synthetic-off-state-id-token",
  };
  await page.addInitScript((value) => {
    localStorage.setItem("openclaw.openclawId.account", JSON.stringify(value));
  }, account);
}

suite.define(() => {
  it("hands off an enabled anonymous callback without private bootstrap or Gateway startup", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      // Mirror the HTTP-proven public attributes in the document before parsing starts.
      await page.route("**/openclaw-id/callback?*", async (route) => {
        const response = await page.request.get(suite.server.baseUrl);
        const body = (await response.text()).replace(
          /<html\b/i,
          '<html data-openclaw-id-enabled="true" data-openclaw-control-ui-base-path=""',
        );
        await route.fulfill({ response, body });
      });
      const sockets: string[] = [];
      page.on("websocket", (socket) => sockets.push(socket.url()));
      await page.goto(
        `${suite.server.baseUrl}openclaw-id/callback?state=synthetic-callback&code=synthetic-code`,
      );
      await page.getByText("Signed in. You can close this window.", { exact: true }).waitFor();
      expect(
        await page.evaluate(() =>
          document.documentElement.hasAttribute("data-openclaw-bootstrap-config"),
        ),
      ).toBe(false);
      expect(
        await page.evaluate(() =>
          JSON.parse(
            localStorage.getItem("openclaw.openclawId.callback.synthetic-callback") ?? "null",
          ),
        ),
      ).toEqual({ state: "synthetic-callback", code: "synthetic-code", error: null });
      expect(new URL(page.url()).search).toBe("");
      expect(sockets).toEqual([]);
    });
  });
  it.each(["absent", "false"] as const)(
    "keeps ordinary surfaces and traffic unchanged with gateway.openclawId.enabled %s",
    async (mode) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const config = { gateway: mode === "false" ? { openclawId: { enabled: false } } : {} };
        const scenario = {
          sessionKey,
          assistantName: "Parity assistant",
          featureMethods: [...defaultControlUiFeatureMethods, "plugins.controlUi.list"],
          presenceUsers: [{ self: true, id: "local-owner", name: "Local owner" }],
          historyMessages: [
            { role: "assistant", content: "Existing conversation stays available." },
          ],
          methodResponses: {
            "config.get": {
              config,
              sourceConfig: config,
              raw: JSON.stringify(config),
              hash: `id-off-${mode}`,
              valid: true,
              exists: true,
              issues: [],
            },
            "config.schema": {
              schema: { type: "object", properties: {} },
              uiHints: {},
              version: "test",
            },
            // The disabled Gateway advertises no People plugin. Server-side filtering has its own proof.
            "plugins.controlUi.list": { revision: "id-off", plugins: [], diagnostics: [] },
            "sessions.search": { results: [], sessions: [] },
            "openclawId.status": {
              status: { state: "off" },
              channel: "local_operator",
              owner: false,
              link: { linked: false },
              services: { issuerUrl: null, discoveryUrl: null, loaderDomain: null },
            },
          },
        };
        const gateway = await installMockGateway(page, scenario);
        await seedStaleAccount(page);
        // Exercise the real HTTP bootstrap boundary without extending the shared mock contract.
        const bootstrap: ReturnType<typeof createControlUiMockBootstrapConfig> & {
          openclawIdEnabled?: boolean;
        } = createControlUiMockBootstrapConfig(scenario);
        delete bootstrap.openclawIdEnabled;
        if (mode === "false") {
          bootstrap.openclawIdEnabled = false;
        }
        await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(bootstrap),
          }),
        );
        // Resolve hashed production chunks from sourcemaps so renaming an asset cannot hide a leak.
        const forbiddenModules = [
          "ui/src/components/openclaw-id/recovery-kit-form.tsx",
          "ui/src/lib/openclaw-id/onepassword-save.ts",
          "ui/src/lib/openclaw-id/onepassword-payload.js",
        ].map((source) => controlUiE2eBuiltModuleRequest(source));
        const assetRequests: string[] = [];
        page.on("request", (request) => {
          if (!request.isNavigationRequest()) {
            assetRequests.push(request.url());
          }
        });
        const checkpoints: Array<{ surface: string; methods: string[] }> = [];
        const checkpoint = async (surface: string) => {
          const methods = (await gateway.getRequests()).map((request) => request.method);
          checkpoints.push({ surface, methods });
          expect
            .soft(
              methods.filter((method) => method.startsWith("openclawId.")),
              surface,
            )
            .toEqual([]);
          const forbiddenAssets = assetRequests.filter(
            (url) =>
              forbiddenModules.some((pattern) => pattern.test(url)) ||
              /(?:1password|onepassword|recovery-kit|openclaw-id-access)/iu.test(url),
          );
          expect.soft(forbiddenAssets, surface).toEqual([]);
        };
        try {
          await page.goto(`${suite.server.baseUrl}new`);
          await page.locator(".new-session-page__message").waitFor();
          await expectNoIdUi(page.locator("body"));
          await checkpoint("new: stale account before opening any menu");

          await gateway.waitForRequest("plugins.controlUi.list");
          const pages = await openSidebarPages(page);
          await pages.getByRole("link", { name: "Sessions", exact: true }).waitFor();
          expect
            .soft(await pages.getByRole("link", { name: "People", exact: true }).count())
            .toBe(0);
          expect.soft(await pages.locator('a[href*="openclaw-id-access"]').count()).toBe(0);
          await expectNoIdUi(pages);
          await checkpoint("sidebar Pages");

          const sidebar = page.locator("openclaw-app-sidebar:visible");
          await sidebar.locator(".sidebar-identity-card").click();
          const menu = sidebar.getByRole("menu");
          const settings = menu.getByRole("menuitem", { name: "Settings", exact: true });
          await settings.waitFor();
          expect
            .soft(await menu.locator(".sidebar-identity-menu__name").textContent())
            .toBe("Local owner");
          await expectNoIdUi(menu);
          await checkpoint("account menu");

          await settings.click();
          const settingsView = await waitForControlUiSettingsTakeover(page);
          await settingsView.sidebar
            .getByRole("link", { name: "Appearance", exact: true })
            .waitFor();
          await expectNoIdUi(page.locator("body"));
          await checkpoint("settings");
          await settingsView.sidebar.getByRole("link", { name: "Labs", exact: true }).click();
          const toggle = page.getByRole("switch", { name: labTitle, exact: true });
          await toggle.waitFor();
          await expect.poll(() => toggle.isDisabled()).toBe(false);
          expect.soft(await toggle.isChecked()).toBe(false);
          expect.soft(await page.getByText(labTitle, { exact: true }).count()).toBe(1);
          await expectNoIdUi(page.locator("body"), true);
          await checkpoint("Labs: only the disabled feature row");
          expect.soft(await gateway.getRequests("config.patch")).toEqual([]);
          expect.soft(await gateway.getRequests("config.set")).toEqual([]);
          expect
            .soft(
              await evaluateControlUiContext(
                page,
                (context) => context.config.current.openclawIdEnabled,
              ),
            )
            .toBe(false);

          // A new document also exercises the cold chat entry, not only a warm SPA transition.
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          const composer = page.locator(".agent-chat__composer-combobox textarea:visible");
          await composer.fill("Keep this unsent draft");
          await page.getByText("Existing conversation stays available.", { exact: true }).waitFor();
          await expectNoIdUi(page.locator("body"));
          await checkpoint("chat");
          await page.keyboard.press("ControlOrMeta+K");
          const palette = page.locator("openclaw-command-palette");
          const input = palette.locator(".cmd-palette__input");
          await input.waitFor();
          const results = palette.locator(".cmd-palette__results");
          await input.fill("Settings");
          await results.getByRole("option").filter({ hasText: "Settings" }).first().waitFor();
          await expectNoIdUi(palette);
          await input.fill("People");
          await gateway.waitForRequest("sessions.search", { match: { query: "People" } });
          await expect.poll(() => results.getAttribute("aria-busy")).toBe("false");
          expect.soft(await results.getByText("People", { exact: true }).count()).toBe(0);
          await expectNoIdUi(palette);
          await checkpoint("command palette");
          expect.soft(await gateway.getRequests("chat.send")).toEqual([]);
          await input.press("Escape");
          await input.waitFor({ state: "hidden" });
          expect.soft(await composer.inputValue()).toBe("Keep this unsent draft");

          await page.goto(`${suite.server.baseUrl}plugin?plugin=openclaw-id-access&id=people`);
          await page.getByText("Plugin panel unavailable", { exact: true }).waitFor();
          expect
            .soft(await page.getByRole("heading", { name: "People", exact: true }).count())
            .toBe(0);
          await expectNoIdUi(page.locator("body"));
          await checkpoint("direct People URL");
        } finally {
          await checkpoint("final document");
          await writeFile(
            path.join(suite.artifactDir, `off-${mode}-requests.json`),
            JSON.stringify({ checkpoints, assetRequests }, null, 2),
          );
        }
      });
    },
  );
});
