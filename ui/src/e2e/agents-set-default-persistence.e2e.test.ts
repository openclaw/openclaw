import path from "node:path";
import { expect, it } from "vitest";
import { createRequireRecord } from "../../../test/helpers/record.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { agentRoster } from "./agent-roster.test-support.ts";
import { configSnapshot, createConfigSuite } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createConfigSuite("Control UI agents Set Default mocked Gateway E2E");

const requireRecord = createRequireRecord("record", "expected-object-value");

function configResponse(config: Record<string, unknown>, hash: string) {
  return { ...configSnapshot(config, hash), sourceConfig: config };
}

suite.define(() => {
  it("persists Set Default through config.set instead of only staging the form draft", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const makeConfig = (agentId: string) => ({
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId } },
          entries: { main: {}, kimi: {} },
        },
      });
      const initialConfig = makeConfig("main");
      const savedConfig = makeConfig("kimi");
      const gateway = await installMockGateway(page, {
        assistantName: "Main agent",
        defaultAgentId: "main",
        methodResponses: {
          "agents.list": agentRoster({ main: "Main agent", kimi: "Kimi agent" }, "main", "agent"),
          "config.get": configResponse(initialConfig, "hash-1"),
          "config.set": configResponse(savedConfig, "hash-2"),
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}settings/agents`);
      expect(response?.status()).toBe(200);

      const agentSelect = page.locator("openclaw-agent-select");
      await agentSelect.locator(".agent-select__trigger").click();
      await agentSelect.getByRole("menuitemradio", { name: "Kimi agent", exact: true }).click();
      await page.getByRole("button", { name: "Set Default", exact: true }).click();

      // A draft-only update never emits config.set.
      const setRequest = await gateway.waitForRequest("config.set");
      const saved = JSON.parse(String(requireRecord(setRequest.params).raw));
      expect(saved).toEqual(savedConfig);
      expect(requireRecord(saved).agents).not.toHaveProperty("list");
    });
  });

  it.each([true, false])(
    "uses Gateway ownership for Set Default state (selection required: %s)",
    async (selectionRequired) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const defaultId = selectionRequired ? "main" : "research";
        const config = {
          agents: {
            ownership: "explicit",
            entries: { main: {}, research: {} },
            ...(!selectionRequired ? { defaults: { systemAgent: { agentId: "research" } } } : {}),
          },
        };
        const gateway = await installMockGateway(page, {
          defaultAgentId: defaultId,
          methodResponses: {
            "agents.list": {
              ...agentRoster(
                { main: "Main agent", research: "Research agent" },
                defaultId,
                "per-sender",
              ),
              ownership: "explicit",
              selectionRequired,
            },
            "config.get": configResponse(config, "roster-hash"),
          },
        });

        await page.goto(`${suite.server.baseUrl}settings/agents`);
        await gateway.waitForRequest("agents.list");
        await page.locator(".agent-select__trigger").click();
        await page.getByRole("menuitemradio", { name: /Research agent/ }).waitFor();
        await page.screenshot({
          path: path.join(
            suite.artifactDir,
            selectionRequired ? "ownerless.png" : "designated.png",
          ),
        });
        expect(await page.locator(".agent-select__option .agent-select__badge").count()).toBe(0);
        await page
          .getByRole("menuitemradio", {
            name: selectionRequired ? "Main agent" : "Research agent",
            exact: true,
          })
          .click();
        const defaultAction = page.getByRole("button", {
          name: selectionRequired ? "Set Default" : "Default",
          exact: true,
        });
        await defaultAction.waitFor();
        await expect.poll(() => defaultAction.isDisabled()).toBe(!selectionRequired);
      });
    },
  );
});
