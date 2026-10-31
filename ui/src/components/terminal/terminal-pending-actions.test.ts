/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { TERMINAL_PANEL_TOGGLE_EVENT } from "../panel-toggle-contract.ts";
import { terminalToggleIntent } from "./terminal-pending-actions.ts";

describe("terminalToggleIntent", () => {
  it.each([
    { detail: { newSession: true, agentId: " ops " }, agentId: "ops" },
    { detail: { open: true, newSession: true }, agentId: "main" },
  ])("retains a new shell request for $agentId before the panel mounts", ({ detail, agentId }) => {
    const event = new CustomEvent(TERMINAL_PANEL_TOGGLE_EVENT, { detail });
    expect(terminalToggleIntent(event, "main")).toEqual({ kind: "open", agentId });
  });

  it("does not queue a new shell when the same request closes the panel", () => {
    const event = new CustomEvent(TERMINAL_PANEL_TOGGLE_EVENT, {
      detail: { open: false, newSession: true },
    });
    expect(terminalToggleIntent(event, "main")).toBeNull();
  });
});
