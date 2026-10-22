import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { expectText } from "./activity-assertions.test-support.ts";
import { captureUiProof } from "./chat-flow.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { configSnapshot } from "./model-setup-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agent model fallback ownership",
  startServerBeforeBrowser: true,
});

const primaryModel = "openai/gpt-5.4";
const inheritedFallback = "anthropic/claude-sonnet-4-6";
const ownFallbacks = ["google/gemini-3-pro"];
const primary = { primary: primaryModel };
const writerWorkspace = "/tmp/agents/writer";

suite.define(() => {
  it.each([
    ["inherits global fallbacks", undefined, [inheritedFallback]],
    ["isolates a string primary", primaryModel, []],
    ["isolates an object primary", primary, []],
    ["preserves disabled fallbacks", { ...primary, fallbacks: [] }, []],
    ["uses agent-owned fallbacks", { ...primary, fallbacks: ownFallbacks }, ownFallbacks],
    ["inherits only the primary", { fallbacks: ownFallbacks }, ownFallbacks],
  ] as const)("%s", async (_name, model, expectedFallbacks) => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const config = {
        agents: {
          ownership: "explicit",
          defaults: {
            systemAgent: { agentId: "main" },
            workspace: "/tmp/agents",
            model: { primary: primaryModel, fallbacks: [inheritedFallback] },
          },
          entries: {
            main: {},
            writer: model === undefined ? {} : { model },
          },
        },
      };
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "agents.list": {
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
            agents: [
              { id: "main", identity: { name: "Main" }, name: "Main" },
              {
                id: "writer",
                identity: { name: "Writer" },
                name: "Writer",
                workspace: writerWorkspace,
                model: { primary: primaryModel, fallbacks: expectedFallbacks },
              },
            ],
          },
          "config.get": configSnapshot(config, "agent-model-fallback-ownership"),
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}settings/agents/main/tools`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("agents.list");
      await gateway.waitForRequest("config.get");
      const agentPicker = page.locator(".settings-sidebar__agent openclaw-agent-select");
      await agentPicker.locator(".agent-select__trigger").click();
      // Switching agents is the user action under test; the Tools panel must survive it.
      await agentPicker
        .locator(".agent-select__option[data-agent-option]")
        .filter({ hasText: "Writer" })
        .evaluate((item) => (item as HTMLElement).click());
      await expect
        .poll(() =>
          agentPicker.evaluate((picker) => (picker as HTMLElement & { value: string }).value),
        )
        .toBe("writer");
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/agents/writer/tools");
      await page.getByRole("tab", { name: "Overview", exact: true }).click();
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe("/settings/agents/writer/overview");

      if (model && !("primary" in Object(model))) {
        await captureUiProof(
          suite,
          page,
          "agent-context",
          `${process.env.OPENCLAW_UI_PROOF_LABEL ?? "agent-context"}.png`,
        );
      }

      await expectText(page.locator(".workspace-link")).toContain(writerWorkspace);
      const modelDescription = page
        .locator(".settings-kv dt")
        .filter({ hasText: "Primary Model" })
        .locator("xpath=following-sibling::dd[1]");
      const displayedModel = expectedFallbacks.length
        ? `${primaryModel} (+${expectedFallbacks.length} fallback)`
        : primaryModel;
      await expectText(modelDescription).toContain(displayedModel);

      const fallbacks = page.locator("openclaw-multi-select.agent-fallbacks");
      await fallbacks.waitFor({ timeout: 10_000 });
      await expect
        .poll(() =>
          fallbacks
            .locator(".multi-select__chip")
            .evaluateAll((chips) => chips.map((chip) => chip.getAttribute("data-value"))),
        )
        .toEqual(expectedFallbacks);
      expect(await gateway.getRequests("config.set")).toHaveLength(0);
    });
  });
});
