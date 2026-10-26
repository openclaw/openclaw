import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "native session sidebar",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const collapsedSessionSectionsStorageKey = "openclaw:sidebar:sessions:collapsed-sections";
const localHost = (sessions: unknown[]) => ({
  hostId: "gateway:local",
  label: "Gateway",
  kind: "gateway",
  connected: true,
  sessions,
});
const capabilities = { continueSession: true, archive: true };
const readOnlyCapabilities = { continueSession: true, archive: false };
const session = (threadId: string, name: string, overrides: Record<string, unknown> = {}) => ({
  threadId,
  name,
  status: "idle",
  archived: false,
  canContinue: true,
  canArchive: true,
  ...overrides,
});
const host = (hostId: string, label: string, overrides: Record<string, unknown> = {}) => ({
  hostId,
  label,
  kind: "node",
  connected: true,
  sessions: [],
  ...overrides,
});
const catalog = (hosts: unknown[], features = capabilities) => ({
  id: "codex",
  label: "Codex",
  capabilities: features,
  hosts,
});
const contextOptions = {
  deviceScaleFactor: 2,
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { height: 1100, width: 1440 },
} as const;
function installCatalog(
  page: Page,
  catalogs: unknown[],
  options: Parameters<typeof installMockGateway>[1] = {},
) {
  return installMockGateway(page, {
    ...options,
    featureMethods: [
      "chat.metadata",
      "chat.startup",
      "sessions.catalog.list",
      ...(options.featureMethods ?? []),
    ],
    methodResponses: { "sessions.catalog.list": { catalogs } },
  });
}
async function withCatalogPage(run: (page: Page) => Promise<void>, hasTouch?: boolean) {
  await suite.withPage({ ...contextOptions, hasTouch }, async ({ page }) => {
    if (hasTouch === undefined) {
      await page.addInitScript(
        (key) => localStorage.removeItem(key),
        collapsedSessionSectionsStorageKey,
      );
    }
    await run(page);
  });
}
suite.define(() => {
  it("hides empty native hosts and the empty Coding section", async () => {
    await withCatalogPage(async (page) => {
      await installCatalog(page, [
        catalog([
          localHost([
            session("thread-shared", "Shared gateway session", { cwd: "/workspace/openclaw" }),
          ]),
          host("node:remote", "Remote Workstation", {
            nodeId: "remote",
            sessions: [
              session("thread-remote", "Remote-only session", {
                cwd: "/workspace/remote",
                canContinue: false,
                canArchive: false,
              }),
            ],
          }),
          host("node:empty", "Empty Workstation", { nodeId: "empty" }),
        ]),
      ]);

      await page.goto(`${suite.server.baseUrl}chat`);
      await page.evaluate(() => {
        document.documentElement.setAttribute("data-theme", "openknot");
        document.documentElement.setAttribute("data-theme-mode", "dark");
      });
      const sessionGroups = page.locator(".sidebar-recent-sessions");
      const section = sessionGroups.locator(':scope > [data-session-section="catalog:codex"]');
      await section.waitFor({ state: "visible" });
      await section.getByText("Shared gateway session", { exact: true }).waitFor();
      await section.getByText("Remote-only session", { exact: true }).waitFor();
      if (captureUiProofEnabled) {
        await sessionGroups.screenshot({
          animations: "disabled",
          path: path.join(
            createControlUiE2eArtifactDir("native-session-discovery"),
            "08-after-deduplicated-session-hosts.png",
          ),
        });
      }

      expect(await sessionGroups.locator(':scope > [data-session-section="work"]').count()).toBe(0);
      expect(await section.getByText("Shared gateway session", { exact: true }).count()).toBe(1);
      expect(await section.locator('[data-session-catalog-host="node:remote"]').count()).toBe(1);
      expect(await section.locator('[data-session-catalog-host="node:empty"]').count()).toBe(0);
    });
  });

  it.each([false, true])("preserves adopted session menus (touch: %s)", async (hasTouch) => {
    const adoptedKey = "agent:main:adopted-native-menu";
    const proofRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const proofDir = proofRoot
      ? createControlUiE2eArtifactDir("adopted-session-menu", proofRoot)
      : undefined;
    const adopted = session("adopted-thread", "Adopted native session", {
      status: "stored",
      sessionKey: adoptedKey,
      canOpenTerminal: true,
      canArchive: false,
    });
    await withCatalogPage(async (page) => {
      await installCatalog(page, [catalog([localHost([adopted])], readOnlyCapabilities)], {
        sessionKey: "agent:main:main",
        terminalEnabled: true,
        sessions: [
          { key: "agent:main:main", kind: "direct", label: "Main session", updatedAt: 2 },
          { key: adoptedKey, kind: "direct", label: "Adopted native session", updatedAt: 1 },
        ],
        featureMethods: ["terminal.open"],
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page.locator(`[data-session-key="${adoptedKey}"]`);
      await row.waitFor({ state: "visible" });
      const menuTrigger = row.locator(".sidebar-recent-session__link");
      const catalogMenu = () => page.locator("openclaw-catalog-session-menu");
      const menuValues = async () =>
        catalogMenu()
          .getByRole("menuitem")
          .evaluateAll((items) =>
            items
              .map((item) => item.getAttribute("data-value"))
              .filter((value): value is string => Boolean(value)),
          );
      const assertCatalogMenu = async (entryPoint: string) => {
        await expect.poll(() => catalogMenu().count()).toBe(1);
        await catalogMenu().getByRole("menu").waitFor();
        await expect.poll(menuValues).toEqual(["viewer", "import", "terminal"]);
        await expect
          .poll(() => catalogMenu().locator('[data-value="terminal"]').getAttribute("disabled"))
          .toBeNull();
        console.info(`[catalog-menu-proof] ${entryPoint} values=${(await menuValues()).join(",")}`);
        if (proofDir) {
          await writeFile(
            path.join(proofDir, `${entryPoint}.png`),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
              row,
              catalogMenu().getByRole("menu"),
            ]),
          );
        }
      };

      const touchMenu = row.locator("[data-sidebar-session-menu]");
      if (hasTouch) {
        await touchMenu.tap();
        await assertCatalogMenu("touch");
      } else {
        expect(await touchMenu.isVisible()).toBe(false);
        await row.click({ button: "right" });
        await assertCatalogMenu("context");
      }
      await page.keyboard.press("Escape");
      await expect.poll(() => catalogMenu().count()).toBe(0);

      for (const key of ["ContextMenu", "Shift+F10"]) {
        await menuTrigger.focus();
        await page.keyboard.press(key);
        await assertCatalogMenu(key);
        await page.keyboard.press("Escape");
        await expect.poll(() => catalogMenu().count()).toBe(0);
      }
    }, hasTouch);
  });
});
