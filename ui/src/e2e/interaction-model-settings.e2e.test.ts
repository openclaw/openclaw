import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { applyMergePatch } from "../../../src/config/merge-patch.js";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { pickerValue, selectPickerValue } from "../test-helpers/select-picker-e2e.ts";
import { agentRoster } from "./agent-roster.test-support.ts";
import { createConfigSuite } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import { requestRaw } from "./model-providers.test-support.ts";

const suite = createConfigSuite("Control UI interaction model settings");
suite.define(() => {
  it("persists independent Computer and Browser models, restores chat routing and leaves other roles unchanged", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { width: 1500, height: 1500 } },
      async ({ page }) => {
        let config: unknown = {
          agents: {
            ownership: "explicit",
            defaults: {
              systemAgent: { agentId: "main" },
              model: "fixture/chat",
              utilityModel: "fixture/utility",
            },
            entries: { main: {} },
          },
        };
        let revision = 0;
        const snapshot = () => ({
          config,
          sourceConfig: config,
          hash: "interaction-" + revision,
          raw: JSON.stringify(config),
          valid: true,
          issues: [],
        });
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "agents.list": agentRoster({ main: "Main" }, "main", "per-sender"),
            "models.list": {
              models: [
                {
                  provider: "fixture",
                  id: "chat",
                  name: "Chat model",
                  available: true,
                  input: ["text", "image"],
                },
                {
                  provider: "fixture",
                  id: "desktop",
                  name: "Desktop specialist",
                  available: true,
                  input: ["text", "image"],
                },
                {
                  provider: "fixture",
                  id: "web",
                  name: "Browser specialist",
                  available: true,
                  input: ["text", "image"],
                },
              ],
            },
            "config.get": snapshot(),
          },
        });
        await page.goto(suite.server.baseUrl + "settings/model-providers");
        const computer = page.locator(
          "openclaw-select-picker:has(#model-providers-computer-model)",
        );
        const browser = page.locator("openclaw-select-picker:has(#model-providers-browser-model)");
        await expect.poll(() => pickerValue(computer)).toBe("");
        await expect.poll(() => pickerValue(browser)).toBe("");
        const capture = async (stage: string) => {
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
            return;
          }
          const surface = page.locator(".model-providers__defaults");
          const frame = await takeControlUiScreenshotFrame(page, surface, [computer, browser], {
            animations: "disabled",
            elements: [surface],
            scrollTo: surface,
          });
          await writeFile(path.join(suite.artifactDir, stage + ".png"), frame.elements[0]!.png);
        };
        await capture("before-chat-model-control");
        const expected: { computerModel?: string; browserModel?: string } = {};
        for (const [kind, value] of [
          ["computer", "fixture/desktop"],
          ["browser", "fixture/web"],
          ["browser", ""],
        ] as const) {
          const picker = kind === "computer" ? computer : browser;
          const before = (await gateway.getRequests("config.patch")).length;
          await gateway.deferNext("config.patch");
          await selectPickerValue(picker, value);
          const patch = requestRaw(await gateway.waitForRequest("config.patch", { after: before }));
          const field = kind === "computer" ? "computerModel" : "browserModel";
          expect(patch).toMatchObject({ agents: { defaults: { [field]: value } } });
          config = applyMergePatch(config, patch);
          expected[field] = value;
          expect(config).toMatchObject({
            agents: {
              defaults: { model: "fixture/chat", utilityModel: "fixture/utility", ...expected },
            },
          });
          revision++;
          await gateway.setMethodResponse("config.get", snapshot());
          await gateway.resolveDeferred("config.patch", {
            ok: true,
            config,
            hash: "interaction-" + revision,
          });
          await page.reload();
          await expect.poll(() => pickerValue(picker)).toBe(value);
          await expect.poll(() => pickerValue(computer)).toBe(expected.computerModel ?? "");
          if (kind === "browser" && value) {
            await capture("after-specialist-model-selection");
          }
        }
      },
    );
  });
});
