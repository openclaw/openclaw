import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eSuite,
  expandCodingSection,
  tooltipTitleText,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Native session discovery settings",
  startServerBeforeBrowser: true,
});
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let uiProofArtifactDir: string;
beforeEach(() => {
  if (captureUiProofEnabled) {
    uiProofArtifactDir = createControlUiE2eArtifactDir("native-session-discovery");
  }
});

suite.define(() => {
  it("explains node-list failures beside available sessions and exposes independent discovery settings", async () => {
    const page = await suite.browser.newPage({ viewport: { height: 1100, width: 1440 } });
    const discoveryPluginSchema = {
      type: "object",
      properties: {
        config: {
          type: "object",
          properties: {
            sessionCatalog: {
              type: "object",
              properties: { enabled: { type: "boolean", default: true } },
            },
          },
        },
      },
    };
    await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "config.get",
        "config.schema",
        "plugins.list",
        "sessions.catalog.list",
      ],
      methodResponses: {
        "config.get": {
          config: {
            plugins: {
              entries: {
                anthropic: { config: { sessionCatalog: { enabled: false } } },
                codex: { config: { sessionCatalog: { enabled: true } } },
              },
            },
          },
          hash: "native-session-discovery-e2e",
        },
        "config.schema": {
          schema: {
            type: "object",
            properties: {
              plugins: {
                type: "object",
                properties: {
                  entries: {
                    type: "object",
                    properties: {
                      anthropic: discoveryPluginSchema,
                      codex: discoveryPluginSchema,
                    },
                  },
                },
              },
            },
          },
          uiHints: {
            "plugins.entries.anthropic.config.sessionCatalog.enabled": {
              label: "Discover Claude Code Sessions",
              help: "List native Claude Code sessions in the sidebar from this Gateway and eligible paired nodes.",
            },
            "plugins.entries.codex.config.sessionCatalog.enabled": {
              label: "Discover Codex Sessions",
              help: "List native Codex sessions in the sidebar from this Gateway and eligible paired nodes.",
            },
          },
          version: "e2e",
          generatedAt: "2026-07-14T00:00:00.000Z",
        },
        "plugins.list": {
          plugins: [
            {
              id: "codex",
              name: "Codex",
              origin: "bundled",
              installed: true,
            },
            {
              id: "anthropic",
              name: "Anthropic",
              origin: "bundled",
              installed: true,
            },
          ],
          diagnostics: [],
          mutationAllowed: true,
        },
        "sessions.catalog.list": {
          catalogs: [
            {
              id: "codex",
              label: "Codex",
              capabilities: { continueSession: true, archive: true },
              hosts: [
                {
                  hostId: "gateway:local",
                  label: "Local Codex",
                  kind: "gateway",
                  connected: true,
                  sessions: [
                    {
                      threadId: "available-native-session",
                      name: "Available native session",
                      status: "idle",
                      source: "cli",
                      archived: false,
                    },
                  ],
                },
                {
                  hostId: "node:registry",
                  label: "Paired nodes",
                  kind: "node",
                  connected: false,
                  sessions: [],
                  error: {
                    code: "NODE_LIST_FAILED",
                    message: "Paired nodes could not be listed: pairing database is locked",
                  },
                },
              ],
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await expandCodingSection(page);
      const warning = page.locator(
        '[data-session-section="catalog:codex"] .sidebar-session-group-toggle',
      );
      await warning.waitFor({ state: "visible" });
      await expect.poll(() => tooltipTitleText(warning)).toContain("[NODE_LIST_FAILED]");
      await expect.poll(() => tooltipTitleText(warning)).toContain("pairing database is locked");
      await expect
        .poll(() => tooltipTitleText(warning))
        .toContain("Settings > Appearance > Session sources");
      expect(await page.getByText("Available native session", { exact: true }).count()).toBe(1);
      expect(await page.locator('[data-session-catalog-host="node:registry"]').count()).toBe(0);

      if (captureUiProofEnabled) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(uiProofArtifactDir, "01-actionable-sidebar-error.png"),
        });
      }

      const readDiscoverySetting = async (
        pluginId: string,
        settingLabel: string,
        expected: boolean,
      ) => {
        await page.goto(`${suite.server.baseUrl}settings/plugins/${pluginId}?view=settings`);
        await waitForControlUiRoute(page, {
          pathname: `/settings/plugins/${pluginId}`,
          routeId: "plugin-settings",
        });
        const setting = page.locator(".settings-row", { hasText: settingLabel });
        await setting.waitFor({ state: "visible" });
        expect(await setting.getByText("eligible paired nodes.", { exact: false }).count()).toBe(1);
        expect(
          await setting.getByRole("checkbox", { name: settingLabel, exact: true }).isChecked(),
        ).toBe(expected);
      };
      await readDiscoverySetting("codex", "Discover Codex Sessions", true);
      await readDiscoverySetting("anthropic", "Discover Claude Code Sessions", false);

      if (captureUiProofEnabled) {
        await page.screenshot({
          fullPage: true,
          path: path.join(uiProofArtifactDir, "02-independent-settings-toggles.png"),
        });
      }
    } finally {
      await page.close();
    }
  });
});
