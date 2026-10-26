import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { buildConfigSchemaCore } from "../../../src/config/schema.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { configSnapshot } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { inspection } from "./plugins-settings-admin.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Knowledge first-install settings" });

suite.define(() => {
  it("shows omitted read/write gates as enabled and retains explicit opt-outs after saving and reloading", async () => {
    // Use the authored manifest consumed by config.schema, not a fixture with invented defaults.
    const manifest = JSON.parse(
      await readFile(
        new URL("../../../extensions/knowledge/openclaw.plugin.json", import.meta.url),
        "utf8",
      ),
    );
    const schema = buildConfigSchemaCore({ plugins: [manifest] });
    const config = { plugins: { entries: { knowledge: { enabled: true } } } };
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read", "operator.admin"],
        methodResponses: {
          "config.get": configSnapshot(config, "knowledge-first-install"),
          "config.schema": schema,
          "plugins.list": {
            plugins: [
              {
                id: "knowledge",
                name: "Knowledge",
                origin: "bundled",
                installed: true,
                enabled: true,
                state: "enabled",
              },
            ],
            diagnostics: [],
            mutationAllowed: true,
          },
          "plugins.inspect": {
            ...inspection,
            plugin: {
              id: "knowledge",
              name: "Knowledge",
              origin: "bundled",
              installed: true,
              enabled: true,
            },
            catalog: undefined,
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/plugins/knowledge?view=settings`);
      const editor = page.locator(".plugin-editor");
      const read = editor.getByRole("checkbox", { name: "Operator Read", exact: true });
      const writes = editor.getByRole("checkbox", { name: "Writes Enabled", exact: true });
      await read.waitFor();
      await writes.waitFor();
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const frame = await takeControlUiScreenshotFrame(page, editor, [read, writes], {
          animations: "disabled",
        });
        await writeFile(path.join(suite.artifactDir, "knowledge-initial.png"), frame.png);
      }
      expect(await read.isChecked()).toBe(true);
      expect(await writes.isChecked()).toBe(true);
      expect(await gateway.getRequests("config.set")).toHaveLength(0);

      for (const [control, expected] of [
        [read, { operatorRead: false }],
        [writes, { operatorRead: false, writesEnabled: false }],
      ] as const) {
        const before = (await gateway.getRequests("config.set")).length;
        await control.click();
        const request = await gateway.waitForRequest("config.set", { after: before });
        expect(JSON.parse(String(asRecord(request.params).raw))).toEqual({
          plugins: { entries: { knowledge: { enabled: true, config: expected } } },
        });
        await page.locator(".settings-save-indicator--saved").waitFor();
        await page.reload();
        await read.waitFor();
        expect(await read.isChecked()).toBe(false);
        expect(await writes.isChecked()).toBe(!("writesEnabled" in expected));
      }
    });
  });
});
