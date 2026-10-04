// Control UI E2E: explicit identity emoji remain intact across agent avatar surfaces.
import path from "node:path";
import type { Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI identity emoji avatars",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("avatar-initial-emoji");
  }
});

const emojiAgent = { id: "emoji", identity: { name: "🚀Rocket", emoji: "🚀" }, name: "🚀Rocket" };
const asciiAgent = { id: "main", identity: { name: "Main" }, name: "Main" };
const emojiGrapheme = "🚀";
const agentsList = {
  defaultId: "main",
  mainKey: "main",
  scope: "agent",
  agents: [asciiAgent, emojiAgent],
};
const agentIdentities = {
  cases: [
    {
      match: { agentId: "emoji" },
      response: { agentId: "emoji", avatar: "", avatarStatus: "none", name: "🚀Rocket" },
    },
    {
      match: { agentId: "main" },
      response: { agentId: "main", avatar: "", avatarStatus: "none", name: "Main" },
    },
  ],
};

async function screenshot(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, name),
  });
}

suite.define(() => {
  it("renders the identity emoji in the sidebar chip and agent menu row", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          defaultAgentId: "main",
          methodResponses: {
            "agent.identity.get": agentIdentities,
            "agents.list": agentsList,
            "chat.startup": {
              agentsList,
              messages: [],
              metadata: { models: [] },
              sessionId: "session:agent:main:main",
              thinkingLevel: null,
            },
            "sessions.list": {
              count: 0,
              defaults: { contextTokens: null, model: null, modelProvider: null },
              path: "",
              sessions: [],
              ts: Date.now(),
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}usage`);
        expect(response?.status()).toBe(200);
        await gateway.waitForRequest("agents.list");
        const sidebar = page.locator("openclaw-app-sidebar");

        await sidebar.getByRole("button", { name: /Switch agent/ }).click();
        const emojiRow = sidebar
          .locator("wa-dropdown.sidebar-agent-menu")
          .getByRole("menuitemradio", { name: "🚀Rocket", exact: true });
        const menuAvatar = emojiRow.locator(".identity-avatar__text");
        await expect.poll(() => menuAvatar.getAttribute("data-avatar")).toBe(emojiGrapheme);
        // The shared picker paints its text through CSS, not a text node.
        await expect
          .poll(() =>
            menuAvatar.evaluate((element) => getComputedStyle(element, "::before").content),
          )
          .toContain(emojiGrapheme);
        await screenshot(page, "01-sidebar-menu-emoji.png");

        await emojiRow.click();
        await expect
          .poll(async () =>
            (await gateway.getRequests("sessions.list")).some(
              (request) =>
                request.params && (request.params as { agentId?: string }).agentId === "emoji",
            ),
          )
          .toBe(true);
        await expect
          .poll(() =>
            sidebar
              .locator(".sidebar-agent-card__avatar .identity-avatar__text")
              .getAttribute("data-avatar"),
          )
          .toBe(emojiGrapheme);
        await screenshot(page, "01-sidebar-chip-emoji.png");
      },
    );
  });

  it("renders the identity emoji in the agent selector dropdown", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          defaultAgentId: "main",
          methodResponses: {
            "agent.identity.get": agentIdentities,
            "agents.list": agentsList,
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/agents`);
        expect(response?.status()).toBe(200);
        await gateway.waitForRequest("agents.list");
        const agentSelect = page.locator(".settings-sidebar__agent openclaw-agent-select");
        await agentSelect.locator(".agent-select__trigger").click();
        const emojiItem = agentSelect.getByRole("menuitemradio", {
          name: "🚀Rocket",
          exact: true,
        });
        const pickerAvatar = emojiItem.locator(".identity-avatar__text");
        await expect.poll(() => pickerAvatar.getAttribute("data-avatar")).toBe(emojiGrapheme);
        await expect
          .poll(() =>
            pickerAvatar.evaluate((element) => getComputedStyle(element, "::before").content),
          )
          .toContain(emojiGrapheme);
        await screenshot(page, "02-agent-selector-emoji.png");
      },
    );
  });

  it("renders the identity emoji in the agents overview identity editor", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        await page.addInitScript(() => {
          Object.defineProperty(Crypto.prototype, "randomUUID", {
            configurable: true,
            value: undefined,
          });
        });
        const config = { agents: { entries: { main: {}, emoji: {} } } };
        const hydratedEmojiAgent = { id: "emoji", identity: { name: "Rocket" }, name: "Rocket" };
        const gateway = await installMockGateway(page, {
          defaultAgentId: "main",
          featureMethods: [...defaultControlUiFeatureMethods, "agents.update"],
          methodResponses: {
            "agents.update": { ok: true },
            "agent.identity.get": {
              cases: [
                {
                  match: { agentId: "emoji" },
                  response: {
                    agentId: "emoji",
                    avatar: "",
                    avatarStatus: "none",
                    emoji: emojiGrapheme,
                    name: "Rocket",
                  },
                },
                agentIdentities.cases[1],
              ],
            },
            "agents.list": { ...agentsList, agents: [asciiAgent, hydratedEmojiAgent] },
            "config.get": {
              config,
              sourceConfig: config,
              hash: "hash-1",
              issues: [],
              raw: JSON.stringify(config),
              valid: true,
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/agents/main/tools`);
        expect(response?.status()).toBe(200);
        expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined");
        expect(await page.evaluate(() => typeof crypto.getRandomValues)).toBe("function");
        await gateway.waitForRequest("agents.list");
        await gateway.waitForRequest("config.get");
        const agentSelect = page.locator(".settings-sidebar__agent openclaw-agent-select");
        await agentSelect.locator(".agent-select__trigger").click();
        await agentSelect.getByRole("menuitemradio", { name: "Rocket", exact: true }).click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/agents/emoji/tools");
        await page.getByRole("tab", { name: "Overview", exact: true }).click();
        await expect
          .poll(() => new URL(page.url()).pathname)
          .toBe("/settings/agents/emoji/overview");
        const picker = page.locator("openclaw-agent-emoji-picker");
        const emojiInput = page.locator(".agent-identity-editor__emoji").getByRole("textbox", {
          name: "Emoji",
        });
        await expect.poll(() => emojiInput.inputValue()).toBe(emojiGrapheme);
        await picker.getByRole("button", { name: "Choose emoji" }).click();
        await expect.poll(() => picker.getByRole("button", { name: "lobster" }).count()).toBe(1);
        await screenshot(page, "03-agents-emoji-picker-open.png");
        expect(await picker.getByRole("textbox", { name: "Paste another emoji" }).count()).toBe(0);
        expect(await picker.getByRole("button", { name: "Use", exact: true }).count()).toBe(0);
        await picker.getByRole("searchbox", { name: "Search emoji…" }).fill("dolphin");
        await picker.getByRole("button", { name: "dolphin", exact: true }).click();
        await expect.poll(() => emojiInput.inputValue()).toBe("🐬");
        await screenshot(page, "04-agents-emoji-selected.png");
        await emojiInput.fill("🪿".repeat(20));
        await expect.poll(() => emojiInput.inputValue()).toBe("🪿".repeat(4));
        const beforeBoundedSave = (await gateway.getRequests("agents.update")).length;
        await page
          .locator(".agent-identity-editor__actions")
          .getByRole("button", { name: "Save" })
          .click();
        const boundedUpdate = await gateway.waitForRequest("agents.update", {
          after: beforeBoundedSave,
        });
        expect(boundedUpdate.params).toMatchObject({ agentId: "emoji", emoji: "🪿".repeat(4) });
        await emojiInput.fill("👨‍👩‍👧‍👦".repeat(3));
        await expect.poll(() => emojiInput.inputValue()).toBe("👨‍👩‍👧‍👦");
        await emojiInput.fill("🪿");
        await expect.poll(() => emojiInput.inputValue()).toBe("🪿");
        const beforeTypedSave = (await gateway.getRequests("agents.update")).length;
        await page
          .locator(".agent-identity-editor__actions")
          .getByRole("button", { name: "Save" })
          .click();
        const update = await gateway.waitForRequest("agents.update", { after: beforeTypedSave });
        expect(update.params).toMatchObject({ agentId: "emoji", emoji: "🪿" });
        await expect
          .poll(() =>
            page
              .locator(".agent-identity-editor__avatar .identity-avatar__text")
              .getAttribute("data-avatar"),
          )
          .toBe(emojiGrapheme);
      },
    );
  });
});
