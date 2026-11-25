import path from "node:path";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createSettingsPageOptions } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  configMocks,
  inspection,
  inventory,
  pluginMethods,
  pluginResponses,
  workboard,
} from "./plugins-settings-admin.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Installed plugin tool blocks",
  startServerBeforeBrowser: true,
});
suite.define(() => {
  it("edits only the selected global tool block from an installed plugin", async () => {
    await suite.withPage(createSettingsPageOptions(), async ({ page }) => {
      const discord = {
        ...workboard,
        id: "discord",
        name: "Discord",
        description: "Bridge agents into Discord servers and DMs.",
      };
      const original = ["other_*", "DISCORD_MODERATE"];
      let deny = [...original];
      let hash = "tool-policy-1";
      let rejectNextPatch = true;
      const snapshot = () => {
        const value = { tools: { deny } };
        return {
          ...configMocks["config.get"],
          config: value,
          raw: JSON.stringify(value),
          hash,
          configRevisionHash: hash,
        };
      };
      const gateway = await installMockGateway(
        page,
        {
          featureMethods: pluginMethods,
          operatorScopes: ["operator.read", "operator.admin"],
          methodResponses: {
            ...pluginResponses(),
            "plugins.list": { ...inventory, plugins: [discord] },
            "plugins.inspect": {
              ...inspection,
              plugin: discord,
              catalog: undefined,
              components: { ...inspection.components, skills: [], mcpServers: [] },
              declared: { ...inspection.declared, tools: ["discord_actions", "discord_moderate"] },
            },
          },
        },
        {
          requestHandlers: {
            "config.get": snapshot,
            "config.patch": (params) => {
              const request = asRecord(params);
              expect(request.baseHash).toBe(hash);
              const patch = JSON.parse(String(request.raw));
              expect(Object.keys(patch)).toEqual(["tools"]);
              expect(Object.keys(patch.tools)).toEqual(["deny"]);
              if (patch.tools.deny.length < deny.length) {
                expect(request.replacePaths).toEqual(["tools.deny"]);
              }
              if (rejectNextPatch) {
                rejectNextPatch = false;
                return {
                  __mockError: {
                    code: "UNAVAILABLE",
                    message: "The tool policy could not be saved.",
                  },
                };
              }
              deny = patch.tools.deny;
              hash += "-saved";
              return { ok: true, config: snapshot().config, hash };
            },
          },
        },
      );
      await page.goto(`${suite.server.baseUrl}settings/plugins/discord`);
      await page.getByText("discord_moderate", { exact: true }).waitFor();
      const section = page.locator(".plugin-catalog-detail");
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const proofDir = createControlUiE2eArtifactDir("plugin-tool-blocks");
        await section.screenshot({
          animations: "disabled",
          path: path.join(proofDir, "plugin-tool-policy.png"),
        });
      }
      const moderate = page.getByRole("switch", {
        name: "Allow discord_moderate",
        exact: true,
      });
      const actions = page.getByRole("switch", {
        name: "Allow discord_actions",
        exact: true,
      });
      expect(await moderate.count()).toBe(1);
      await expect.poll(() => moderate.isChecked()).toBe(false);
      expect(await actions.isChecked()).toBe(true);
      expect(await gateway.getRequests("config.schema")).toHaveLength(0);
      await actions.click();
      await section.getByText("The tool policy could not be saved.", { exact: true }).waitFor();
      expect(await actions.isChecked()).toBe(true);
      expect(deny).toEqual(original);
      await section.getByRole("button", { name: "Try again", exact: true }).click();
      await expect.poll(() => deny).toEqual([...original, "discord_actions"]);
      await moderate.click();
      await expect.poll(() => deny).toEqual(["other_*", "discord_actions"]);
      expect(await gateway.getRequests("plugins.setEnabled")).toHaveLength(0);
      await page.reload();
      await expect.poll(() => actions.isChecked()).toBe(false);
      expect(await moderate.isChecked()).toBe(true);
      deny.push("discord_*");
      hash += "-admin";
      await page.reload();
      await page.getByText("Blocked by a global rule").first().waitFor();
      expect(await page.getByRole("switch", { name: /^Allow /u }).count()).toBe(0);
      expect(await gateway.getRequests("config.set")).toHaveLength(0);
    });
  });
});
