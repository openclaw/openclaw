// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { extractQuickSettingsSecurity } from "./app-render.ts";
import type { AppViewState } from "./app-view-state.ts";

function createState(configOverride: Record<string, unknown> = {}): AppViewState {
  return {
    configSnapshot: { config: configOverride } as AppViewState["configSnapshot"],
  } as unknown as AppViewState;
}

describe("extractQuickSettingsSecurity", () => {
  it("reads exec security from tools.exec.security", () => {
    const state = createState({
      tools: { exec: { security: "full" } },
    });
    expect(extractQuickSettingsSecurity(state).execPolicy).toBe("full");
  });

  it("defaults to allowlist when tools.exec.security is not set", () => {
    const state = createState({});
    expect(extractQuickSettingsSecurity(state).execPolicy).toBe("allowlist");
  });

  it("does not read from agents.defaults.exec.security", () => {
    const state = createState({
      agents: { defaults: { exec: { security: "full" } } },
    });
    expect(extractQuickSettingsSecurity(state).execPolicy).toBe("allowlist");
  });

  it("reads deny value from tools.exec.security", () => {
    const state = createState({
      tools: { exec: { security: "deny" } },
    });
    expect(extractQuickSettingsSecurity(state).execPolicy).toBe("deny");
  });
});
