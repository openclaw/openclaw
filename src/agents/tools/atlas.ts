import type { Locator, Page } from "playwright-core";
import type { ResolvedBrowserProfile } from "../../browser/config.js";
import type { OpenClawConfig } from "../../config/config.js";
import { browserStart, browserStatus } from "../../browser/client.js";
import { resolveBrowserConfig, resolveProfile } from "../../browser/config.js";
import { DEFAULT_ATLAS_BROWSER_PROFILE_NAME } from "../../browser/constants.js";
import { getPwAiModule } from "../../browser/pw-ai-module.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("atlas");

const DEFAULT_ATLAS_CHAT_URL = "https://chatgpt.com";

export class AtlasUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtlasUnavailableError";
  }
}

export type AtlasPromptResult = {
  text: string;
  tookMs: number;
};

export function resolveAtlasProfile(config?: OpenClawConfig): ResolvedBrowserProfile | null {
  const resolved = resolveBrowserConfig(config?.browser, config);
  if (!resolved.enabled) {
    return null;
  }
  const profile = resolveProfile(resolved, DEFAULT_ATLAS_BROWSER_PROFILE_NAME);
  return profile ?? null;
}

export function canUseAtlas(options?: { config?: OpenClawConfig; sandboxed?: boolean }): boolean {
  if (
    process.env.NODE_ENV === "test" ||
    process.env.VITEST ||
    process.env.VITEST_WORKER_ID ||
    process.env.JEST_WORKER_ID
  ) {
    return false;
  }
  if (options?.sandboxed) {
    return false;
  }
  try {
    return Boolean(resolveAtlasProfile(options?.config));
  } catch {
    return false;
  }
}

async function ensureAtlasCdpUrl(profile: ResolvedBrowserProfile): Promise<string> {
  try {
    let status = await browserStatus(undefined, { profile: profile.name });
    if (!status.running) {
      await browserStart(undefined, { profile: profile.name });
      status = await browserStatus(undefined, { profile: profile.name });
    }
    const cdpUrl = status.cdpUrl?.trim() || profile.cdpUrl?.trim() || "";
    if (!cdpUrl) {
      throw new AtlasUnavailableError("Atlas profile has no CDP URL.");
    }
    return cdpUrl;
  } catch (err) {
    if (err instanceof AtlasUnavailableError) {
      throw err;
    }
    throw new AtlasUnavailableError(`Atlas browser is not reachable: ${String(err)}`);
  }
}

async function findPromptInput(page: Page, timeoutMs: number): Promise<Locator> {
  const deadline = Date.now() + Math.max(2000, timeoutMs);
  const selectors = [
    "textarea#prompt-textarea",
    'textarea[data-testid="prompt-textarea"]',
    'textarea[placeholder*="Message"]',
    "textarea",
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const timeout = Math.min(2500, Math.max(500, deadline - Date.now()));
    if (timeout <= 0) {
      break;
    }
    try {
      await locator.waitFor({ state: "visible", timeout });
      if (await locator.isEnabled().catch(() => false)) {
        return locator;
      }
    } catch {
      // try next selector
    }
  }

  throw new AtlasUnavailableError(
    "ChatGPT input not found. Open Atlas, sign in to ChatGPT, then try again.",
  );
}

async function clickSend(page: Page, input: Locator): Promise<void> {
  const sendButton = page.locator('button[data-testid="send-button"]').first();
  const canClick = await sendButton.isVisible().catch(() => false);
  if (canClick && (await sendButton.isEnabled().catch(() => false))) {
    await sendButton.click().catch(() => {});
    return;
  }
  await input.press("Enter").catch(() => {});
}

async function waitForAssistantMessage(
  page: Page,
  baselineCount: number,
  timeoutMs: number,
): Promise<Locator> {
  const selector = '[data-message-author-role="assistant"]';
  const messages = page.locator(selector);
  const timeout = Math.max(2000, timeoutMs);

  try {
    await page.waitForFunction(
      ({ count, sel }) => document.querySelectorAll(sel).length > count,
      { count: baselineCount, sel: selector },
      { timeout },
    );
  } catch {
    // fall through - maybe the assistant updated the last message instead of adding new
  }

  const count = await messages.count();
  if (count === 0) {
    throw new AtlasUnavailableError("No ChatGPT response detected.");
  }
  return messages.nth(count - 1);
}

async function readStableText(page: Page, locator: Locator, timeoutMs: number): Promise<string> {
  const start = Date.now();
  let last = "";
  let stableTicks = 0;

  while (Date.now() - start < timeoutMs) {
    const text = (await locator.innerText().catch(() => ""))?.trim() ?? "";
    if (text && text === last) {
      stableTicks += 1;
    } else {
      stableTicks = 0;
    }
    last = text;
    if (stableTicks >= 3 && text) {
      return text;
    }
    await page.waitForTimeout(400);
  }
  return last;
}

export async function runAtlasPrompt(options: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
  prompt: string;
  timeoutMs: number;
  url?: string;
}): Promise<AtlasPromptResult> {
  if (options.sandboxed) {
    throw new AtlasUnavailableError("Atlas is not available in sandboxed sessions.");
  }

  const profile = resolveAtlasProfile(options.config);
  if (!profile) {
    throw new AtlasUnavailableError("Atlas profile is not configured.");
  }

  const pwModule = await getPwAiModule({ mode: "soft" });
  if (!pwModule?.createPageViaPlaywright || !pwModule?.getPageForTargetId) {
    throw new AtlasUnavailableError("Playwright is not available for Atlas automation.");
  }

  const cdpUrl = await ensureAtlasCdpUrl(profile);
  const chatUrl = options.url?.trim() || DEFAULT_ATLAS_CHAT_URL;
  const start = Date.now();

  const pageInfo = await pwModule.createPageViaPlaywright({ cdpUrl, url: chatUrl });

  try {
    const page = await pwModule.getPageForTargetId({ cdpUrl, targetId: pageInfo.targetId });
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    const input = await findPromptInput(page, options.timeoutMs);
    const assistantMessages = page.locator('[data-message-author-role="assistant"]');
    const baselineCount = await assistantMessages.count();

    await input.fill(options.prompt, { timeout: Math.min(options.timeoutMs, 10_000) });
    await clickSend(page, input);

    const message = await waitForAssistantMessage(page, baselineCount, options.timeoutMs);
    const text = await readStableText(page, message, options.timeoutMs);
    if (!text) {
      throw new AtlasUnavailableError("ChatGPT returned an empty response.");
    }
    return { text, tookMs: Date.now() - start };
  } catch (err) {
    log.debug(`Atlas prompt failed: ${String(err)}`);
    if (err instanceof AtlasUnavailableError) {
      throw err;
    }
    throw new AtlasUnavailableError(`Atlas prompt failed: ${String(err)}`);
  } finally {
    await pwModule
      .closePageByTargetIdViaPlaywright?.({ cdpUrl, targetId: pageInfo.targetId })
      .catch(() => {});
  }
}
