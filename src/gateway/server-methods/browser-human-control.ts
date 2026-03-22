import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * In-memory store: profile name → Set of targetIds where a human has tapped in.
 * Reset on gateway restart. Agents should check browser.getHumanControlledTabs
 * before taking any browser action and pause when the requested tab is listed.
 */
const humanControlledTabs = new Map<string, Set<string>>();

export const browserHumanControlHandlers: GatewayRequestHandlers = {
  /**
   * browser.tapIn — mark a specific browser tab as human-controlled.
   * The agent should pause and wait until browser.tapOut is called for the tab.
   */
  "browser.tapIn": async ({ params, respond }) => {
    const targetId = typeof params.targetId === "string" ? params.targetId.trim() : "";
    const profile = typeof params.profile === "string" ? params.profile.trim() : "";
    if (!targetId || !profile) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "targetId and profile are required"),
      );
      return;
    }
    if (!humanControlledTabs.has(profile)) {
      humanControlledTabs.set(profile, new Set());
    }
    humanControlledTabs.get(profile)!.add(targetId);
    respond(true, { ok: true, profile, targetId }, undefined);
  },

  /**
   * browser.tapOut — remove human-control flag for a tab; the agent may resume.
   */
  "browser.tapOut": async ({ params, respond }) => {
    const targetId = typeof params.targetId === "string" ? params.targetId.trim() : "";
    const profile = typeof params.profile === "string" ? params.profile.trim() : "";
    if (!targetId || !profile) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "targetId and profile are required"),
      );
      return;
    }
    humanControlledTabs.get(profile)?.delete(targetId);
    respond(true, { ok: true, profile, targetId }, undefined);
  },

  /**
   * browser.getHumanControlledTabs — return all tabs currently under human control.
   * Browser agents call this before acting to respect the human-in-the-loop signal.
   */
  "browser.getHumanControlledTabs": async ({ respond }) => {
    const result: Record<string, string[]> = {};
    for (const [profile, tabs] of humanControlledTabs.entries()) {
      if (tabs.size > 0) {
        result[profile] = [...tabs];
      }
    }
    respond(true, { tabs: result }, undefined);
  },
};
