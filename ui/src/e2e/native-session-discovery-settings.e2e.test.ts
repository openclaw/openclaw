import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Native session discovery settings",
  startServerBeforeBrowser: true,
});
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const objectSchema = (properties: Record<string, unknown>) => ({ type: "object", properties });
const plugins = [
  { id: "codex", name: "Codex", enabled: true },
  { id: "anthropic", name: "Claude Code", enabled: false },
];

suite.define(() => {
  it("exposes independent native session discovery settings", async () => {
    const page = await suite.browser.newPage({ viewport: { height: 1100, width: 1440 } });
    const discoveryPluginSchema = objectSchema({
      config: objectSchema({
        sessionCatalog: objectSchema({ enabled: { type: "boolean", default: true } }),
      }),
    });
    const entries = Object.fromEntries(
      plugins.map(({ id, enabled }) => [id, { config: { sessionCatalog: { enabled } } }]),
    );
    await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "config.get",
        "config.schema",
        "plugins.list",
      ],
      methodResponses: {
        "config.get": {
          config: { plugins: { entries } },
          hash: "native-session-discovery-e2e",
        },
        "config.schema": {
          schema: objectSchema({
            plugins: objectSchema({
              entries: objectSchema(
                Object.fromEntries(plugins.map(({ id }) => [id, discoveryPluginSchema])),
              ),
            }),
          }),
          uiHints: Object.fromEntries(
            plugins.map(({ id, name }) => [
              `plugins.entries.${id}.config.sessionCatalog.enabled`,
              {
                label: `Discover ${name} Sessions`,
                help: `List native ${name} sessions in the sidebar from this Gateway and eligible paired nodes.`,
              },
            ]),
          ),
          version: "e2e",
          generatedAt: "2026-07-14T00:00:00.000Z",
        },
        "plugins.list": {
          plugins: plugins.map(({ id }) => ({
            id,
            name: id === "codex" ? "Codex" : "Anthropic",
            origin: "bundled",
            installed: true,
          })),
          diagnostics: [],
          mutationAllowed: true,
        },
      },
    });
    try {
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
          animations: "disabled",
          fullPage: true,
          path: path.join(
            createControlUiE2eArtifactDir("native-session-discovery"),
            "02-independent-settings-toggles.png",
          ),
        });
      }
    } finally {
      await page.close();
    }
  });
});
