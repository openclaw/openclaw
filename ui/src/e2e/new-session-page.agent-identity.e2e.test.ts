import type { BrowserContextOptions, Page } from "playwright";
import { expect, it } from "vitest";
import { createPageOpener } from "./new-session-page.scenario.test-support.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
  pollCount,
  pollValue,
  pollDisabled,
  pollAttribute,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const longName = "Deployment Safety and Release Verification Agent";

const agentsList = {
  agents: [
    { id: "main", workspace: "/home/operator/pacino", workspaceGit: true },
    { id: "research", workspace: "/home/operator/research", workspaceGit: true },
    { id: "release", workspace: "/home/operator/release", workspaceGit: true },
  ],
  defaultId: "main",
  mainKey: "main",
  scope: "agent",
};

const agentIdentities = {
  cases: (
    [
      ["main", "🎬", "Pacino", "workspace"],
      ["research", "A", "Assistant", "default"],
      ["release", "R", longName, "agent"],
    ] as const
  ).map(([agentId, avatar, name, nameSource]) => ({
    match: { agentId },
    response: { agentId, avatar, avatarStatus: "none", name, nameSource },
  })),
};

const CONTEXT: BrowserContextOptions = {
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { height: 900, width: 1440 },
};

async function setTheme(page: Page, mode: "dark" | "light") {
  await page.emulateMedia({ colorScheme: mode });
  await page.evaluate((nextMode) => {
    const root = document.documentElement;
    root.dataset.themeMode = nextMode;
    root.dataset.themeResolved = nextMode;
    root.style.colorScheme = nextMode;
  }, mode);
}

suite.define(() => {
  const openPage = createPageOpener(suite);
  async function identityPage(options: Parameters<typeof installMockGateway>[1] = {}) {
    const page = await openPage(CONTEXT);
    const gateway = await installMockGateway(page, {
      defaultAgentId: "main",
      ...options,
      methodResponses: {
        "agent.identity.get": agentIdentities,
        "agents.list": agentsList,
        ...options.methodResponses,
      },
    });
    const picker = page.locator(".new-session-page__select--agent openclaw-agent-select");
    return { page, gateway, picker };
  }
  it("drops a pending skill completion after an agent switch", async () => {
    const { page, gateway, picker } = await identityPage({
      deferredMethods: ["commands.list"],
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "commands.list",
        "sessions.create",
        "sessions.dispatch",
      ],
      methodResponses: {
        "chat.metadata": { models: [] },
      },
    });
    await page.goto(`${suite.server.baseUrl}new?agent=main`);
    await gateway.waitForRequest("agent.identity.get");
    const composer = page.locator(".new-session-page__composer textarea");
    await composer.fill("$");
    await composer.press("End");
    await composer.dispatchEvent("select");
    await gateway.waitForRequest("commands.list");

    await picker.evaluate((element) => {
      (element as HTMLElement & { onSelect: (agentId: string) => void }).onSelect("research");
    });
    await gateway.resolveDeferred("commands.list", {
      commands: [
        {
          name: "main_only",
          source: "skill",
          skillModelVisible: true,
        },
      ],
    });

    await pollLocatorText(picker.locator(".agent-select__label")).toBe("research");
    await pollCount(page.getByRole("listbox", { name: "Skill references" })).toBe(0);
    await pollValue(composer).toBe("$");
  });

  it.each(["dark", "light"] as const)(
    "uses resolved identity in the New Session hero and picker in %s mode",
    async (theme) => {
      const page = await openPage(CONTEXT);
      const gateway = await installMockGateway(page, {
        defaultAgentId: "main",
        methodResponses: { "agent.identity.get": agentIdentities, "agents.list": agentsList },
      });
      const picker = page.locator(".new-session-page__select--agent openclaw-agent-select");
      await setTheme(page, theme);
      await page.goto(`${suite.server.baseUrl}new?agent=main`);
      await gateway.waitForRequest("agent.identity.get");

      const hero = page.locator(".agent-chat__welcome h2");
      const sidebar = page.locator("openclaw-app-sidebar");
      await pollLocatorText(sidebar.locator(".sidebar-agent-card__name")).toContain("Pacino");
      await hero.waitFor();
      const welcomeEmoji = page.locator(".agent-chat__welcome-avatar .identity-avatar__text");
      await pollAttribute(welcomeEmoji, "data-avatar").toBe("🎬");
      await expect
        .poll(() => welcomeEmoji.evaluate((element) => getComputedStyle(element).fontSize))
        .toBe("56px");
      await picker.locator(".agent-select__label").waitFor();
      await page.waitForLoadState("networkidle");
      expect(await gateway.getRequests("agent.identity.get")).toMatchObject([
        { params: { agentId: "main" } },
      ]);
      await picker.locator(".agent-select__trigger").click();
      await pollLocatorText(hero).toBe("Pacino");
      await pollLocatorText(picker.locator(".agent-select__label")).toBe("Pacino");
      const selectedAgent = picker.locator(
        ".agent-select__option[data-agent-option][data-selected]",
      );
      await pollLocatorText(selectedAgent).toContain("Pacino");
      await expect
        .poll(() => selectedAgent.evaluate((element) => document.activeElement === element))
        .toBe(true);
      const unnamedAgent = picker.getByRole("menuitemradio", {
        name: "research",
        exact: true,
      });
      await pollLocatorText(unnamedAgent).toContain("research");
      const longNameAgent = picker.getByRole("menuitemradio", { name: longName, exact: true });
      await pollLocatorText(longNameAgent).toContain(longName);
      await longNameAgent.hover();

      await unnamedAgent.click();
      await pollLocatorText(hero).toBe("research");
      await pollLocatorText(picker.locator(".agent-select__label")).toBe("research");
      await picker.evaluate((element) => {
        (element as HTMLElement & { disabled: boolean }).disabled = true;
      });
      await pollDisabled(picker.locator(".agent-select__trigger")).toBe(true);
    },
  );
});
