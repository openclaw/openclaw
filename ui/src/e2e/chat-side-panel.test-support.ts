import type { Locator, Page } from "playwright";
import {
  closeChatLayoutMenu,
  openChatLayoutMenu,
  selectChatLayoutAction,
} from "../test-helpers/chat-layout-menu.ts";

export async function failNextDeviceIdentityMint(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    let identityMintFailed = false;
    Object.defineProperty(globalThis.crypto, "getRandomValues", {
      configurable: true,
      value(array: Uint8Array<ArrayBuffer>) {
        if (!identityMintFailed) {
          identityMintFailed = true;
          throw new Error("device identity unavailable");
        }
        Object.defineProperty(globalThis.crypto, "getRandomValues", {
          configurable: true,
          value: getRandomValues,
        });
        getRandomValues(array);
        return array;
      },
    });
  });
}

export async function openChatSidePanelType(page: Page | Locator, label: string): Promise<void> {
  const panelActions: Record<string, { slot: string; action: string | RegExp }> = {
    Browser: { slot: "browser", action: "Toggle browser panel" },
    browser: { slot: "browser", action: "Toggle browser panel" },
    Desktop: { slot: "desktop", action: /^(Toggle desktop panel|Desktop)$/ },
    Files: { slot: "workspace", action: /^(Show session files|Collapse session workspace)$/ },
    "Side chat": { slot: "companion", action: /^(Show side chat|Collapse side chat)$/ },
    Subagents: { slot: "subagents", action: "Subagents" },
    Terminal: { slot: "terminal", action: "Toggle terminal" },
  };
  const panel = panelActions[label];
  const content = panel && page.locator(`[data-panel-slot="${panel.slot}"]:not([hidden])`);
  if (await content?.isVisible()) {
    return;
  }
  if (panel?.slot === "subagents") {
    const menu = await openChatLayoutMenu(page);
    await menu.getByRole("menuitemcheckbox", { name: panel.action, exact: true }).setChecked(true);
    await closeChatLayoutMenu(page);
    return;
  }
  await selectChatLayoutAction(page, panel?.action ?? label);
}

export async function focusChatSidePanel(page: Page): Promise<void> {
  await selectChatLayoutAction(page, /^Swap /);
  await selectChatLayoutAction(page, "Focus");
  await page.locator(".sidebar-region--expanded").waitFor();
}

export async function restoreChatAsMain(page: Page): Promise<void> {
  const side = page.locator('[data-region-header="side"]');
  await side.locator('wa-tab[panel="conversation"]').click();
  await selectChatLayoutAction(page, /^Swap /);
  await page.locator('.sidebar-region__primary[data-region="main"]').waitFor();
}

export async function dockChatSidePanel(
  page: Page,
  dock: "left" | "right" | "bottom",
): Promise<void> {
  await selectChatLayoutAction(page, `Move side panel ${dock === "bottom" ? "below" : dock}`);
  await page.locator(`.sidebar-region--${dock}`).waitFor();
}

export async function activateChatHeaderPanelAction(page: Page, label: string): Promise<void> {
  await selectChatLayoutAction(page, label === "Desktop" ? "Toggle desktop panel" : label);
}
