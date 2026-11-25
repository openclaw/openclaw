import { expect, it } from "vitest";
import { sourceConfigSnapshot } from "../lib/config/config-snapshot.test-support.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { openAgentFallbackChain, requestRaw } from "./model-providers.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agent fallback removal",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it.each([
    { width: 1440, long: false, removed: "oak", remaining: "ash" },
    { width: 400, long: true, removed: "ash", remaining: "oak" },
  ])(
    "removes an unfocused fallback at $width px without changing other agents",
    async ({ width, long, removed, remaining: remainingId }) => {
      await suite.withPage(
        { ...createControlUiE2eContextOptions(), viewport: { width, height: 1000 } },
        async ({ page }) => {
          const model = { primary: "fixture/birch", fallbacks: ["fixture/oak", "fixture/ash"] };
          const config = {
            agents: {
              ownership: "explicit",
              defaults: { systemAgent: { agentId: "main" }, model },
              entries: { main: { model }, mill: { name: "Cider Mill", model } },
            },
          };
          const gateway = await installMockGateway(page, {
            featureMethods: [
              ...defaultControlUiFeatureMethods,
              "agents.files.list",
              "agents.files.get",
            ],
            models: ["birch", "oak", "ash"].map((id) => ({
              id,
              name: `${id[0]!.toUpperCase()}${id.slice(1)} counter${long ? " — extended reasoning and multilingual analysis with long context" : ""}`,
              provider: "fixture",
            })),
            methodResponses: {
              "agents.list": {
                defaultId: "main",
                mainKey: "main",
                scope: "agent",
                agents: [
                  { id: "main", name: "Main", model },
                  { id: "mill", name: "Cider Mill", model },
                ],
              },
              "config.get": sourceConfigSnapshot(config, "fallback-click"),
            },
          });
          await page.goto(`${suite.server.baseUrl}settings/agents/mill/overview`);
          const editor = page.locator("openclaw-agents-page");
          await editor.locator(".agent-overview").waitFor();
          const fallbacks = await openAgentFallbackChain(editor);
          const values = () =>
            fallbacks
              .locator(".multi-select__chip")
              .evaluateAll((chips) => chips.map((chip) => chip.getAttribute("data-value")));
          const remove = fallbacks.locator(`[data-value="fixture/${removed}"] .chip-remove`);
          await page.getByRole("tab", { name: "Overview", exact: true }).click();
          expect(await fallbacks.evaluate((field) => field.matches(":focus-within"))).toBe(false);
          await remove.hover();
          await page.mouse.down();
          expect(await values()).toEqual(["fixture/oak", "fixture/ash"]);
          expect(await gateway.getRequests("config.set")).toHaveLength(0);
          await page.mouse.up();
          await expect.poll(values).toEqual([`fixture/${remainingId}`]);
          await expect.poll(() => gateway.getRequests("config.set")).toHaveLength(1);
          const saved = requestRaw((await gateway.getRequests("config.set"))[0]!);
          expect(saved.agents).toEqual({
            ...config.agents,
            entries: {
              main: { model },
              mill: {
                name: "Cider Mill",
                model: { ...model, fallbacks: [`fixture/${remainingId}`] },
              },
            },
          });

          const remaining = fallbacks.locator(`[data-value="fixture/${remainingId}"] .chip-remove`);
          await remaining.hover();
          await page.mouse.down();
          await page.mouse.move(10, 10);
          await page.mouse.up();
          expect(await values()).toEqual([`fixture/${remainingId}`]);
          expect(await gateway.getRequests("config.set")).toHaveLength(1);
          await remaining.focus();
          await page.keyboard.press("Enter");
          await expect.poll(values).toEqual([]);
          await expect.poll(() => gateway.getRequests("config.set")).toHaveLength(2);
        },
      );
    },
  );
});
