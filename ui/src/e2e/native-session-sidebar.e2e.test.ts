import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
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
let uiProofArtifactDir: string;
beforeEach(() => {
  if (captureUiProofEnabled) {
    uiProofArtifactDir = createControlUiE2eArtifactDir("native-session-discovery");
  }
});

suite.define(() => {
  it("hides empty native hosts and the empty Coding section", async () => {
    const context = await suite.newBrowserContext({
      deviceScaleFactor: 2,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1100, width: 1440 },
    });
    const page = await context.newPage();
    await page.addInitScript(
      (key) => localStorage.removeItem(key),
      collapsedSessionSectionsStorageKey,
    );
    await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
      methodResponses: {
        "sessions.catalog.list": {
          catalogs: [
            {
              id: "codex",
              label: "Codex",
              capabilities: { continueSession: true, archive: true },
              hosts: [
                {
                  hostId: "gateway:local",
                  label: "Gateway",
                  kind: "gateway",
                  connected: true,
                  sessions: [
                    {
                      threadId: "thread-shared",
                      name: "Shared gateway session",
                      cwd: "/workspace/openclaw",
                      status: "idle",
                      archived: false,
                      canContinue: true,
                      canArchive: true,
                    },
                  ],
                },
                {
                  hostId: "node:remote",
                  label: "Remote Workstation",
                  kind: "node",
                  connected: true,
                  nodeId: "remote",
                  sessions: [
                    {
                      threadId: "thread-remote",
                      name: "Remote-only session",
                      cwd: "/workspace/remote",
                      status: "idle",
                      archived: false,
                      canContinue: false,
                      canArchive: false,
                    },
                  ],
                },
                {
                  hostId: "node:empty",
                  label: "Empty Workstation",
                  kind: "node",
                  connected: true,
                  nodeId: "empty",
                  sessions: [],
                },
              ],
            },
          ],
        },
      },
    });

    try {
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
          path: path.join(uiProofArtifactDir, "08-after-deduplicated-session-hosts.png"),
        });
      }

      expect(await sessionGroups.locator(':scope > [data-session-section="work"]').count()).toBe(0);
      expect(await section.getByText("Shared gateway session", { exact: true }).count()).toBe(1);
      expect(await section.locator('[data-session-catalog-host="node:remote"]').count()).toBe(1);
      expect(await section.locator('[data-session-catalog-host="node:empty"]').count()).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("preserves native actions across adopted session menu entry points", async () => {
    const adoptedKey = "agent:main:adopted-native-menu";
    const proofRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const proofDir = proofRoot
      ? createControlUiE2eArtifactDir("adopted-session-menu", proofRoot)
      : undefined;
    const context = await suite.newBrowserContext({
      deviceScaleFactor: 2,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1100, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      sessionKey: "agent:main:main",
      terminalEnabled: true,
      sessions: [
        { key: "agent:main:main", kind: "direct", label: "Main session", updatedAt: 2 },
        { key: adoptedKey, kind: "direct", label: "Adopted native session", updatedAt: 1 },
      ],
      featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list", "terminal.open"],
      methodResponses: {
        "sessions.catalog.list": {
          catalogs: [
            {
              id: "codex",
              label: "Codex",
              capabilities: { continueSession: true, archive: false },
              hosts: [
                {
                  hostId: "gateway:local",
                  label: "Gateway",
                  kind: "gateway",
                  connected: true,
                  sessions: [
                    {
                      threadId: "adopted-thread",
                      name: "Adopted native session",
                      status: "stored",
                      archived: false,
                      sessionKey: adoptedKey,
                      canContinue: true,
                      canOpenTerminal: true,
                      canArchive: false,
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page.locator(`[data-session-key="${adoptedKey}"]`);
      await row.waitFor({ state: "visible" });
      const menuButton = row.locator('[data-session-menu="true"]');
      const catalogMenu = () => page.locator("openclaw-catalog-session-menu");
      const menuValues = async () =>
        catalogMenu()
          .locator("wa-dropdown-item")
          .evaluateAll((items) =>
            items
              .map((item) => item.getAttribute("value"))
              .filter((value): value is string => Boolean(value)),
          );
      const assertCatalogMenu = async (entryPoint: string) => {
        await expect.poll(() => catalogMenu().count()).toBe(1);
        await expect.poll(menuValues).toEqual(["viewer", "terminal"]);
        await expect
          .poll(() => catalogMenu().locator('[value="terminal"]').getAttribute("disabled"))
          .toBeNull();
        console.info(`[catalog-menu-proof] ${entryPoint} values=${(await menuValues()).join(",")}`);
        if (proofDir) {
          await writeFile(
            path.join(proofDir, `${entryPoint}.png`),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
              row,
              catalogMenu(),
            ]),
          );
        }
      };

      await row.hover();
      await menuButton.hover();
      await menuButton.click();
      await assertCatalogMenu("01-button");
      await page.keyboard.press("Escape");
      await expect.poll(() => catalogMenu().count()).toBe(0);

      await row.click({ button: "right" });
      await assertCatalogMenu("02-context");
      await page.keyboard.press("Escape");
      await expect.poll(() => catalogMenu().count()).toBe(0);

      for (const key of ["ContextMenu", "Shift+F10"]) {
        await menuButton.focus();
        await page.keyboard.press(key);
        await assertCatalogMenu(key);
        await page.keyboard.press("Escape");
        await expect.poll(() => catalogMenu().count()).toBe(0);
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
