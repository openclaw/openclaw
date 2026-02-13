/**
 * Browser Action Executor
 *
 * Executes browser actions using OpenClaw's existing browser control system.
 * This is "Aether's body" — the part that actually visits pages, clicks buttons,
 * and scrapes data on behalf of the operator.
 *
 * Integrates with the browser control server (Playwright/CDP) that OpenClaw
 * already provides, so we get profile support, Chrome extension relay, etc.
 */

import type {
  BrowserAction,
  BrowserActionResult,
  ConductorAuthorization,
  ConductorBrowserConfig,
  ConductorExecutor,
  ExternalAccessRequest,
} from "@aether/conductor";

export function createBrowserExecutor(config: ConductorBrowserConfig): ConductorExecutor {
  const profile = config.profile ?? "openclaw";
  const actionTimeoutMs = config.actionTimeoutMs ?? 30_000;
  const captureScreenshots = config.captureScreenshots !== false;

  return {
    async execute(
      request: ExternalAccessRequest,
      authorization: ConductorAuthorization,
    ): Promise<BrowserActionResult[]> {
      const actions = resolveActions(request, authorization);
      if (actions.length === 0) {
        return [];
      }

      const results: BrowserActionResult[] = [];

      for (const action of actions) {
        try {
          const result = await executeAction(action, { profile, actionTimeoutMs });
          results.push(result);

          // Stop on navigation failure — subsequent actions won't make sense
          if (!result.success && action.type === "navigate") {
            break;
          }
        } catch (err) {
          results.push({
            action,
            success: false,
            error: String(err),
          });
        }
      }

      // Auto-screenshot at the end if configured and no explicit screenshot was taken
      if (captureScreenshots && !actions.some((a) => a.type === "screenshot")) {
        try {
          const screenshotResult = await executeAction(
            { type: "screenshot" },
            { profile, actionTimeoutMs },
          );
          results.push(screenshotResult);
        } catch {
          // Best effort — don't fail the whole execution
        }
      }

      return results;
    },
  };
}

/**
 * Resolve the final list of actions to execute, merging the request's
 * suggested actions with any operator instructions.
 */
function resolveActions(
  request: ExternalAccessRequest,
  authorization: ConductorAuthorization,
): BrowserAction[] {
  // Start with the request's suggested actions
  const actions: BrowserAction[] = [...(request.suggestedActions ?? [])];

  // If no suggested actions but we have a URL, navigate to it
  if (actions.length === 0 && request.url) {
    actions.push({ type: "navigate", url: request.url });
    actions.push({ type: "extract-text" });
  }

  // If the operator provided instructions, they might override
  if (authorization.instructions) {
    const instructions = authorization.instructions.toLowerCase();
    // "only screenshot" / "just screenshot"
    if (instructions.includes("only screenshot") || instructions.includes("just screenshot")) {
      const navAction = actions.find((a) => a.type === "navigate");
      return navAction ? [navAction, { type: "screenshot" }] : [{ type: "screenshot" }];
    }
    // "only fetch the X" — keep navigate + extract
    if (instructions.includes("only fetch") || instructions.includes("just fetch")) {
      const navAction = actions.find((a) => a.type === "navigate");
      return navAction ? [navAction, { type: "extract-text" }] : [{ type: "extract-text" }];
    }
  }

  return actions;
}

/**
 * Execute a single browser action via the OpenClaw browser control API.
 */
async function executeAction(
  action: BrowserAction,
  opts: { profile: string; actionTimeoutMs: number },
): Promise<BrowserActionResult> {
  // Lazy imports to avoid loading browser modules at startup
  const { browserNavigate, browserScreenshotAction } = await import("../browser/client-actions.js");
  const { browserSnapshot, browserStart, browserStatus } = await import("../browser/client.js");

  const { profile } = opts;

  // Ensure browser is running
  try {
    const status = await browserStatus(undefined, { profile });
    if (!status || (status as { running?: boolean }).running === false) {
      await browserStart(undefined, { profile });
    }
  } catch {
    // Try starting anyway
    try {
      await browserStart(undefined, { profile });
    } catch {
      // Continue — the action itself will fail if browser isn't available
    }
  }

  switch (action.type) {
    case "navigate": {
      try {
        const result = await browserNavigate(undefined, {
          url: action.url,
          profile,
        });
        return {
          action,
          success: true,
          data: `Navigated to ${action.url}`,
        };
      } catch (err) {
        return { action, success: false, error: String(err) };
      }
    }

    case "screenshot": {
      try {
        const result = await browserScreenshotAction(undefined, {
          profile,
          fullPage: false,
          type: "png",
          element: action.selector,
        });
        return {
          action,
          success: true,
          screenshotPath: (result as { path?: string }).path,
          data: `Screenshot saved to ${(result as { path?: string }).path}`,
        };
      } catch (err) {
        return { action, success: false, error: String(err) };
      }
    }

    case "extract-text": {
      try {
        const snapshot = await browserSnapshot(undefined, {
          format: "ai",
          profile,
          selector: action.selector,
        });
        const text =
          typeof snapshot === "object" && snapshot !== null
            ? ((snapshot as { snapshot?: string }).snapshot ?? JSON.stringify(snapshot))
            : String(snapshot);
        return {
          action,
          success: true,
          data: text,
        };
      } catch (err) {
        return { action, success: false, error: String(err) };
      }
    }

    case "click": {
      try {
        const { browserAct } = await import("../browser/client-actions.js");
        await browserAct(undefined, { kind: "click", ref: action.selector }, { profile });
        return {
          action,
          success: true,
          data: `Clicked ${action.selector}`,
        };
      } catch (err) {
        return { action, success: false, error: String(err) };
      }
    }

    case "type": {
      try {
        const { browserAct } = await import("../browser/client-actions.js");
        await browserAct(
          undefined,
          { kind: "type", ref: action.selector, text: action.text },
          { profile },
        );
        return {
          action,
          success: true,
          data: `Typed into ${action.selector}`,
        };
      } catch (err) {
        return { action, success: false, error: String(err) };
      }
    }

    case "wait": {
      await new Promise((resolve) => setTimeout(resolve, action.ms));
      return {
        action,
        success: true,
        data: `Waited ${action.ms}ms`,
      };
    }

    case "scrape": {
      try {
        // Navigate first, then extract
        await browserNavigate(undefined, { url: action.url, profile });
        const snapshot = await browserSnapshot(undefined, {
          format: "ai",
          profile,
        });
        const text =
          typeof snapshot === "object" && snapshot !== null
            ? ((snapshot as { snapshot?: string }).snapshot ?? JSON.stringify(snapshot))
            : String(snapshot);
        return {
          action,
          success: true,
          data: text,
        };
      } catch (err) {
        return { action, success: false, error: String(err) };
      }
    }

    default:
      return {
        action,
        success: false,
        error: `Unknown action type: ${(action as { type: string }).type}`,
      };
  }
}
