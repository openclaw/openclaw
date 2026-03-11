/**
 * Browser Automation Gating Wrapper for ClarityBurst
 *
 * This module provides utilities for wrapping browser automation calls with ClarityBurst
 * BROWSER_AUTOMATE execution-boundary gating. All high-risk browser actions must pass through
 * the gate before execution.
 *
 * Pattern:
 *   await applyBrowserAutomateGateAndNavigate(page, url);
 *
 * The gate will:
 * 1. Extract action type (navigate, click, fill, etc.) and target from parameters
 * 2. Route through ClarityBurst BROWSER_AUTOMATE gate
 * 3. Throw ClarityBurstAbstainError if the gate abstains (CONFIRM or CLARIFY)
 * 4. Execute the browser action if the gate approves (PROCEED)
 * 5. Log the decision with contractId, outcome, action type, and target
 */

import type { Page } from "playwright-core";
import { ClarityBurstAbstainError } from "./errors.js";
import { applyBrowserAutomateOverrides, type BrowserAutomateContext } from "./decision-override.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const gatingLog = createSubsystemLogger("clarityburst-browser-automate-gating");

/**
 * Type guard to check if result is an abstain outcome
 */
function isAbstainOutcome(
  result: any
): result is { outcome: "ABSTAIN_CONFIRM" | "ABSTAIN_CLARIFY"; reason?: string; instructions?: string; contractId?: string | null } {
  return result && (result.outcome === "ABSTAIN_CONFIRM" || result.outcome === "ABSTAIN_CLARIFY");
}

/**
 * Extract hostname from URL for logging
 */
function extractHostname(url?: string): string {
  if (!url) return "unknown";
  try {
    const parsed = new URL(url);
    return parsed.hostname || url;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

/**
 * Get current page URL for logging
 */
function safeGetPageUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "unknown";
  }
}

/**
 * Apply BROWSER_AUTOMATE gate and execute page.goto (navigation)
 *
 * This is the primary wrapper for navigation calls that should be gated.
 * It applies the ClarityBurst BROWSER_AUTOMATE gate immediately before the navigation
 * is executed.
 *
 * @param page - The Playwright Page object
 * @param url - The target URL to navigate to
 * @param options - Optional Playwright goto options
 * @returns Promise that resolves with the response if gate approves
 * @throws ClarityBurstAbstainError if the gate returns ABSTAIN_CONFIRM or ABSTAIN_CLARIFY
 *
 * @example
 * ```typescript
 * const response = await applyBrowserAutomateGateAndNavigate(page, "https://example.com");
 * ```
 */
export async function applyBrowserAutomateGateAndNavigate(
  page: Page,
  url: string,
  options?: Parameters<Page["goto"]>[1]
): Promise<Awaited<ReturnType<Page["goto"]>>> {
  const targetHostname = extractHostname(url);

  // Create context for the BROWSER_AUTOMATE gate
  const context: BrowserAutomateContext = {
    stageId: "BROWSER_AUTOMATE",
    action: "navigate",
    url: targetHostname,
    userConfirmed: false,
  };

  // Apply the BROWSER_AUTOMATE gate
  const gateResult = await applyBrowserAutomateOverrides(context);

  // Log the gating decision
  gatingLog.debug("BROWSER_AUTOMATE gate decision", {
    contractId: gateResult.contractId,
    outcome: gateResult.outcome,
    action: "navigate",
    targetUrl: targetHostname,
  });

  // If gate abstains, throw the appropriate error
  if (isAbstainOutcome(gateResult)) {
    const error = new ClarityBurstAbstainError({
      stageId: "BROWSER_AUTOMATE",
      outcome: gateResult.outcome,
      reason: gateResult.reason ?? "UNKNOWN",
      contractId: gateResult.contractId ?? null,
      instructions: gateResult.instructions ?? `Navigation to ${targetHostname} blocked by ClarityBurst BROWSER_AUTOMATE gate.`,
    });
    gatingLog.warn("BROWSER_AUTOMATE gate blocked navigation", {
      contractId: gateResult.contractId,
      reason: gateResult.reason,
      targetUrl: targetHostname,
    });
    throw error;
  }

  // Gate approved: execute the navigation
  gatingLog.debug("BROWSER_AUTOMATE gate approved navigation", {
    contractId: gateResult.contractId,
    targetUrl: targetHostname,
  });

  return page.goto(url, options);
}

/**
 * Apply BROWSER_AUTOMATE gate and execute page.click
 *
 * This wrapper applies the ClarityBurst gate before performing a click action.
 *
 * @param page - The Playwright Page object
 * @param selector - The CSS selector of the element to click
 * @param options - Optional Playwright click options
 * @returns Promise that resolves when click is complete if gate approves
 * @throws ClarityBurstAbstainError if the gate abstains
 *
 * @example
 * ```typescript
 * await applyBrowserAutomateGateAndClick(page, "button#submit");
 * ```
 */
export async function applyBrowserAutomateGateAndClick(
  page: Page,
  selector: string,
  options?: Parameters<Page["click"]>[1]
): Promise<void> {
  const currentUrl = safeGetPageUrl(page);

  const context: BrowserAutomateContext = {
    stageId: "BROWSER_AUTOMATE",
    action: "click",
    selector,
    url: extractHostname(currentUrl),
    userConfirmed: false,
  };

  const gateResult = await applyBrowserAutomateOverrides(context);

  gatingLog.debug("BROWSER_AUTOMATE gate decision", {
    contractId: gateResult.contractId,
    outcome: gateResult.outcome,
    action: "click",
    selector,
    url: extractHostname(currentUrl),
  });

  if (isAbstainOutcome(gateResult)) {
    const error = new ClarityBurstAbstainError({
      stageId: "BROWSER_AUTOMATE",
      outcome: gateResult.outcome,
      reason: gateResult.reason ?? "UNKNOWN",
      contractId: gateResult.contractId ?? null,
      instructions: gateResult.instructions ?? `Click on "${selector}" blocked by ClarityBurst BROWSER_AUTOMATE gate.`,
    });
    gatingLog.warn("BROWSER_AUTOMATE gate blocked click", {
      contractId: gateResult.contractId,
      reason: gateResult.reason,
      selector,
    });
    throw error;
  }

  gatingLog.debug("BROWSER_AUTOMATE gate approved click", {
    contractId: gateResult.contractId,
    selector,
  });

  return page.click(selector, options);
}

/**
 * Apply BROWSER_AUTOMATE gate and execute page.fill (input submission)
 *
 * This wrapper applies the ClarityBurst gate before filling in a form field.
 *
 * @param page - The Playwright Page object
 * @param selector - The CSS selector of the input element
 * @param text - The text to fill in
 * @param options - Optional Playwright fill options
 * @returns Promise that resolves when fill is complete if gate approves
 * @throws ClarityBurstAbstainError if the gate abstains
 *
 * @example
 * ```typescript
 * await applyBrowserAutomateGateAndFill(page, "input#password", "secret123");
 * ```
 */
export async function applyBrowserAutomateGateAndFill(
  page: Page,
  selector: string,
  text: string,
  options?: Parameters<Page["fill"]>[2]
): Promise<void> {
  const currentUrl = safeGetPageUrl(page);

  const context: BrowserAutomateContext = {
    stageId: "BROWSER_AUTOMATE",
    action: "fill",
    selector,
    url: extractHostname(currentUrl),
    userConfirmed: false,
  };

  const gateResult = await applyBrowserAutomateOverrides(context);

  gatingLog.debug("BROWSER_AUTOMATE gate decision", {
    contractId: gateResult.contractId,
    outcome: gateResult.outcome,
    action: "fill",
    selector,
    url: extractHostname(currentUrl),
  });

  if (isAbstainOutcome(gateResult)) {
    const error = new ClarityBurstAbstainError({
      stageId: "BROWSER_AUTOMATE",
      outcome: gateResult.outcome,
      reason: gateResult.reason ?? "UNKNOWN",
      contractId: gateResult.contractId ?? null,
      instructions: gateResult.instructions ?? `Fill input "${selector}" blocked by ClarityBurst BROWSER_AUTOMATE gate.`,
    });
    gatingLog.warn("BROWSER_AUTOMATE gate blocked fill", {
      contractId: gateResult.contractId,
      reason: gateResult.reason,
      selector,
    });
    throw error;
  }

  gatingLog.debug("BROWSER_AUTOMATE gate approved fill", {
    contractId: gateResult.contractId,
    selector,
  });

  return page.fill(selector, text, options);
}

/**
 * Apply BROWSER_AUTOMATE gate and execute page.press (keyboard-triggered action)
 *
 * This wrapper applies the ClarityBurst gate before pressing a keyboard key.
 *
 * @param page - The Playwright Page object
 * @param selector - The CSS selector of the element to focus
 * @param key - The key to press (e.g., "Enter", "Escape")
 * @param options - Optional Playwright press options
 * @returns Promise that resolves when key press is complete if gate approves
 * @throws ClarityBurstAbstainError if the gate abstains
 *
 * @example
 * ```typescript
 * await applyBrowserAutomateGateAndPress(page, "input#search", "Enter");
 * ```
 */
export async function applyBrowserAutomateGateAndPress(
  page: Page,
  selector: string,
  key: string,
  options?: Parameters<Page["press"]>[2]
): Promise<void> {
  const currentUrl = safeGetPageUrl(page);

  const context: BrowserAutomateContext = {
    stageId: "BROWSER_AUTOMATE",
    action: "press",
    selector,
    url: extractHostname(currentUrl),
    userConfirmed: false,
  };

  const gateResult = await applyBrowserAutomateOverrides(context);

  gatingLog.debug("BROWSER_AUTOMATE gate decision", {
    contractId: gateResult.contractId,
    outcome: gateResult.outcome,
    action: "press",
    key,
    selector,
    url: extractHostname(currentUrl),
  });

  if (isAbstainOutcome(gateResult)) {
    const error = new ClarityBurstAbstainError({
      stageId: "BROWSER_AUTOMATE",
      outcome: gateResult.outcome,
      reason: gateResult.reason ?? "UNKNOWN",
      contractId: gateResult.contractId ?? null,
      instructions: gateResult.instructions ?? `Press key on "${selector}" blocked by ClarityBurst BROWSER_AUTOMATE gate.`,
    });
    gatingLog.warn("BROWSER_AUTOMATE gate blocked press", {
      contractId: gateResult.contractId,
      reason: gateResult.reason,
      selector,
      key,
    });
    throw error;
  }

  gatingLog.debug("BROWSER_AUTOMATE gate approved press", {
    contractId: gateResult.contractId,
    selector,
    key,
  });

  return page.press(selector, key, options);
}

/**
 * Apply BROWSER_AUTOMATE gate and execute page.evaluate (with external effect)
 *
 * This wrapper applies the ClarityBurst gate before evaluating JavaScript that
 * has external side effects. Use this only for evaluate calls that modify browser state
 * or interact with external systems.
 *
 * @param page - The Playwright Page object
 * @param pageFunction - The function to evaluate in the browser
 * @param arg - Optional argument to pass to the function
 * @returns Promise that resolves with the result if gate approves
 * @throws ClarityBurstAbstainError if the gate abstains
 *
 * @example
 * ```typescript
 * await applyBrowserAutomateGateAndEvaluate(page, () => {
 *   document.getElementById("form").submit();
 * });
 * ```
 */
export async function applyBrowserAutomateGateAndEvaluate<R, Arg>(
  page: Page,
  pageFunction: (arg: Arg) => R | Promise<R>,
  arg?: Arg
): Promise<R>;
export async function applyBrowserAutomateGateAndEvaluate<R>(
  page: Page,
  pageFunction: () => R | Promise<R>
): Promise<R>;
export async function applyBrowserAutomateGateAndEvaluate<R, Arg = void>(
  page: Page,
  pageFunction: ((arg: Arg) => R | Promise<R>) | (() => R | Promise<R>),
  arg?: Arg
): Promise<R> {
  const currentUrl = safeGetPageUrl(page);

  const context: BrowserAutomateContext = {
    stageId: "BROWSER_AUTOMATE",
    action: "evaluate",
    url: extractHostname(currentUrl),
    userConfirmed: false,
  };

  const gateResult = await applyBrowserAutomateOverrides(context);

  gatingLog.debug("BROWSER_AUTOMATE gate decision", {
    contractId: gateResult.contractId,
    outcome: gateResult.outcome,
    action: "evaluate",
    url: extractHostname(currentUrl),
  });

  if (isAbstainOutcome(gateResult)) {
    const error = new ClarityBurstAbstainError({
      stageId: "BROWSER_AUTOMATE",
      outcome: gateResult.outcome,
      reason: gateResult.reason ?? "UNKNOWN",
      contractId: gateResult.contractId ?? null,
      instructions: gateResult.instructions ?? `JavaScript evaluation blocked by ClarityBurst BROWSER_AUTOMATE gate.`,
    });
    gatingLog.warn("BROWSER_AUTOMATE gate blocked evaluate", {
      contractId: gateResult.contractId,
      reason: gateResult.reason,
    });
    throw error;
  }

  gatingLog.debug("BROWSER_AUTOMATE gate approved evaluate", {
    contractId: gateResult.contractId,
  });

  return arg !== undefined ? page.evaluate(pageFunction as any, arg) : page.evaluate(pageFunction as any);
}
