import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserContextOptions, Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofStage = process.env.OPENCLAW_AGENT_IDENTITY_PROOF_STAGE ?? "after";

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
      ["release", "R", "Deployment Safety and Release Verification Agent", "agent"],
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

async function capture(target: Page | Locator, name: string, fullPage = true) {
  if (!captureProof) {
    return;
  }
  const directory = path.join(suite.artifactDir, "new-session-agent-identity", proofStage);
  await mkdir(directory, { recursive: true });
  await target.screenshot({
    animations: "disabled",
    ...(fullPage ? { fullPage: true } : {}),
    path: path.join(directory, `${proofStage}-${name}`),
  });
}

const captureElement = (locator: Locator, name: string) => capture(locator, name, false);

async function identityPage(options: Parameters<typeof installMockGateway>[1] = {}) {
  const context = await suite.browser.newContext(CONTEXT);
  const page = await context.newPage();
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
  return { context, page, gateway, picker };
}

suite.define(() => {
  it("drops a pending skill completion after an agent switch", async () => {
    const { context, page, gateway, picker } = await identityPage({
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

    try {
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
      await expect
        .poll(() => page.getByRole("listbox", { name: "Skill references" }).count())
        .toBe(0);
      await expect.poll(() => composer.inputValue()).toBe("$");
    } finally {
      await context.close();
    }
  });

  it.each(["dark", "light"] as const)(
    "uses resolved identity in the New Session hero and picker in %s mode",
    async (theme) => {
      const { context, page, gateway, picker } = await identityPage();

      try {
        await setTheme(page, theme);
        await page.goto(`${suite.server.baseUrl}new?agent=main`);
        await gateway.waitForRequest("agent.identity.get");

        const hero = page.locator(".agent-chat__welcome h2");
        const sidebar = page.locator("openclaw-app-sidebar");
        await pollLocatorText(sidebar.locator(".sidebar-agent-card__name")).toContain("Pacino");
        await hero.waitFor();
        const welcomeEmoji = page.locator(".agent-chat__welcome-avatar .identity-avatar__text");
        await expect.poll(() => welcomeEmoji.getAttribute("data-avatar")).toBe("🎬");
        await expect
          .poll(() => welcomeEmoji.evaluate((element) => getComputedStyle(element).fontSize))
          .toBe("56px");
        if (theme === "dark") {
          await capture(page, "dark-welcome-emoji.png");
        }
        await picker.locator(".agent-select__label").waitFor();
        await page.waitForLoadState("networkidle");
        const identityRequests = await gateway.getRequests("agent.identity.get");
        expect(identityRequests).toMatchObject([{ params: { agentId: "main" } }]);
        await picker.locator(".agent-select__trigger").click();
        await capture(page, `${theme}-named-picker-open.png`);
        await captureElement(
          picker.locator(".agent-select__trigger"),
          `${theme}-named-trigger-crop.png`,
        );
        await pollLocatorText(hero).toBe("Pacino");
        await pollLocatorText(picker.locator(".agent-select__label")).toBe("Pacino");
        const selectedAgent = picker.locator(
          ".agent-select__option[data-agent-option][data-selected]",
        );
        await pollLocatorText(selectedAgent).toContain("Pacino");
        await expect
          .poll(() => selectedAgent.evaluate((element) => document.activeElement === element))
          .toBe(true);
        await captureElement(selectedAgent, `${theme}-selected-focus.png`);
        const unnamedAgent = picker.getByRole("menuitemradio", {
          name: "research",
          exact: true,
        });
        await pollLocatorText(unnamedAgent).toContain("research");
        const longName = "Deployment Safety and Release Verification Agent";
        const longNameAgent = picker.getByRole("menuitemradio", { name: longName, exact: true });
        await pollLocatorText(longNameAgent).toContain(longName);
        await longNameAgent.hover();
        await captureElement(longNameAgent, `${theme}-long-name-hover.png`);

        await unnamedAgent.click();
        await pollLocatorText(hero).toBe("research");
        await pollLocatorText(picker.locator(".agent-select__label")).toBe("research");
        await capture(page, `${theme}-unnamed-id-fallback.png`);
        await picker.evaluate((element) => {
          (element as HTMLElement & { disabled: boolean }).disabled = true;
        });
        await expect.poll(() => picker.locator(".agent-select__trigger").isDisabled()).toBe(true);
        await captureElement(picker, `${theme}-disabled.png`);
      } finally {
        await context.close();
      }
    },
  );
});
