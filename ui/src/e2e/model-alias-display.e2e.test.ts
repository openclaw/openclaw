import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { configSnapshot } from "./model-setup-fixtures.test-support.ts";

const suite = createChatFlowE2eSuite();

const model = (provider: string, id: string, name: string, alias: string) => ({
  provider,
  id,
  name,
  alias,
});
const models = [
  model("anthropic", "claude-opus-4-8", "Opus 4.8", "opus"),
  model("anthropic", "claude-sonnet-5", "Sonnet 5", "sonnet"),
  model("nvidia", "moonshotai/kimi-k2.5", "Kimi K2.5", "Kimi K2.5 (NVIDIA)"),
];

async function createContext() {
  return suite.newBrowserContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1280 },
  });
}

suite.define(() => {
  it("keeps model versions and custom aliases visible in the chat picker", async () => {
    const context = await createContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["models.list", "chat.startup", "sessions.patch"],
      models,
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const main = page.getByRole("main");
      const picker = main.locator('[data-chat-model-select="true"]').first();
      await picker.waitFor({ state: "visible", timeout: 10_000 });
      await picker.click();

      const option = (ref: string) =>
        main.locator(`[data-chat-model-option="${ref}"] .chat-controls__model-option-name`);
      const opus = option("anthropic/claude-opus-4-8");
      const sonnet = option("anthropic/claude-sonnet-5");
      await expect.poll(() => opus.textContent()).toBe("Opus 4.8 · opus");
      await expect.poll(() => sonnet.textContent()).toBe("Sonnet 5 · sonnet");

      const nvidia = option("nvidia/moonshotai/kimi-k2.5");
      await expect.poll(() => nvidia.textContent()).toBe("Kimi K2.5");
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("uses the same versioned catalog labels in the Agents model picker", async () => {
    const context = await createContext();
    const page = await context.newPage();
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-8" },
          models: Object.fromEntries(
            models.map(({ provider, id, alias }) => [`${provider}/${id}`, { alias }]),
          ),
        },
        entries: { main: {} },
      },
    };
    const gateway = await installMockGateway(page, {
      defaultAgentId: "main",
      models,
      methodResponses: {
        "agents.list": {
          agents: [{ id: "main", identity: { name: "Main" }, name: "Main" }],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "config.get": configSnapshot(config, "versioned-model-aliases"),
      },
    });

    try {
      const response = await page.goto(`${suite.server.baseUrl}settings/agents/main/overview`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("agents.list");
      await gateway.waitForRequest("config.get");
      const modelRequest = await gateway.waitForRequest("models.list");
      expect(modelRequest.params).toEqual({ agentId: "main", view: "configured" });
      expect(await gateway.getRequests("models.list")).toHaveLength(1);

      const select = page.locator(
        'openclaw-agents-page openclaw-select-picker:has([role="listbox"][aria-label^="Primary model"])',
      );
      await select.waitFor({ state: "visible", timeout: 10_000 });
      await select.locator(".picker-select__trigger").click();
      for (const [ref, label] of [
        ["anthropic/claude-opus-4-8", "Opus 4.8 · opus"],
        ["anthropic/claude-sonnet-5", "Sonnet 5 · sonnet"],
        ["nvidia/moonshotai/kimi-k2.5", "Kimi K2.5 (NVIDIA)"],
      ]) {
        await expect
          .poll(() => select.locator(`[role="option"][data-value="${ref}"]`).textContent())
          .toContain(label);
      }
      expect(await gateway.getRequests("config.set")).toHaveLength(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
