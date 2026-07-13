// Control UI E2E: grapheme-aware avatar initials render intact (not dangling
// surrogate halves) for emoji-leading agent display names across every live
// avatar fallback surface.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "avatar-initial-emoji");

const emojiAgent = { id: "emoji", identity: { name: "🚀Rocket" }, name: "🚀Rocket" };
const asciiAgent = { id: "main", identity: { name: "Main" }, name: "Main" };
const emojiGrapheme = "🚀";

let browser: Browser;
let server: ControlUiE2eServer;

async function screenshot(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, name),
  });
}

describeControlUiE2e("Control UI grapheme-aware avatar initials", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is not available at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("renders the emoji grapheme initial in the sidebar chip and agent menu row", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      defaultAgentId: "main",
      methodResponses: {
        "agents.list": {
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
          agents: [asciiAgent, emojiAgent],
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

    try {
      await page.goto(`${server.baseUrl}usage`);
      await gateway.waitForRequest("agents.list");
      const sidebar = page.locator("openclaw-app-sidebar");

      // Open the sidebar agent-card menu and inspect the emoji agent row's
      // avatar icon slot (app-sidebar-agent-menu renderAgentRow fallback).
      await sidebar.locator(".sidebar-agent-card__main").click();
      const emojiRow = sidebar
        .locator("wa-dropdown.sidebar-agent-menu")
        .locator('wa-dropdown-item[value="agent:emoji"]');
      await expect
        .poll(() => emojiRow.locator(".sidebar-agent-section__avatar").textContent())
        .toBe(emojiGrapheme);

      // Switch to the emoji agent; the sidebar card avatar text fallback
      // (app-sidebar cardAvatarText) must keep the full grapheme cluster.
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
        .poll(() => sidebar.locator(".sidebar-agent-card__avatar-text").textContent())
        .toBe(emojiGrapheme);
      await screenshot(page, "01-sidebar-chip-emoji.png");
    } finally {
      await context.close();
    }
  });

  it("renders the emoji grapheme initial in the agent selector dropdown", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      defaultAgentId: "main",
      methodResponses: {
        "agents.list": {
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
          agents: [asciiAgent, emojiAgent],
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}agents`);
      const agentSelect = page.locator("wa-dropdown.agent-select");
      await agentSelect.locator(".agent-select__trigger").click();
      const emojiItem = agentSelect.getByRole("menuitemcheckbox", {
        name: "🚀Rocket",
        exact: true,
      });
      await expect
        .poll(() => emojiItem.locator(".agent-select__avatar--text").textContent())
        .toBe(emojiGrapheme);
      await screenshot(page, "02-agent-selector-emoji.png");
    } finally {
      await context.close();
    }
  });

  it("renders the emoji grapheme initial in the agents overview identity editor", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      defaultAgentId: "main",
      methodResponses: {
        "agents.list": {
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
          agents: [asciiAgent, emojiAgent],
        },
        "agent.identity.get": {
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
        },
        "config.get": {
          config: { agents: { list: [{ id: "main" }, { id: "emoji" }] } },
          hash: "hash-1",
          issues: [],
          raw: '{"agents":{"list":[{"id":"main"},{"id":"emoji"}]}}',
          valid: true,
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}agents`);
      // Select the emoji agent via the page's agent-select dropdown (the
      // canonical way the agents page chooses its active agent), then switch
      // to the Overview panel to reach the identity editor avatar text.
      const agentSelect = page.locator("wa-dropdown.agent-select");
      await agentSelect.locator(".agent-select__trigger").click();
      // Select by the rendered item label (the menuitem accessible name also
      // includes the avatar grapheme, so an exact role-name match is fragile).
      await agentSelect.getByText("🚀Rocket", { exact: true }).click();
      await page.getByRole("button", { name: "Overview", exact: true }).click();
      await expect
        .poll(() => page.locator(".agent-identity-editor__avatar-text").textContent())
        .toBe(emojiGrapheme);
      await screenshot(page, "03-agents-overview-emoji.png");
    } finally {
      await context.close();
    }
  });
});
