// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { extractQuickSettingsSecurity } from "./app-render.ts";
import type { AppViewState } from "./app-view-state.ts";

function makeState(config: Record<string, unknown>): AppViewState {
  return { configForm: config } as unknown as AppViewState;
}

describe("extractQuickSettingsSecurity", () => {
  it("reads execPolicy from tools.exec.security", () => {
    const result = extractQuickSettingsSecurity(
      makeState({ tools: { exec: { security: "full" } } }),
    );
    expect(result.execPolicy).toBe("full");
  });

  it("reads execPolicy from tools.exec.security when set to deny", () => {
    const result = extractQuickSettingsSecurity(
      makeState({ tools: { exec: { security: "deny" } } }),
    );
    expect(result.execPolicy).toBe("deny");
  });

  it("returns allowlist default when tools.exec.security is missing", () => {
    expect(extractQuickSettingsSecurity(makeState({})).execPolicy).toBe("allowlist");
    expect(extractQuickSettingsSecurity(makeState({ tools: { exec: {} } })).execPolicy).toBe(
      "allowlist",
    );
  });

  it("ignores legacy agents.defaults.exec.security path", () => {
    const result = extractQuickSettingsSecurity(
      makeState({
        tools: { exec: { security: "full" } },
        agents: { defaults: { exec: { security: "deny" } } },
      }),
    );
    expect(result.execPolicy).toBe("full");
  });

  it("trims whitespace and ignores empty strings", () => {
    expect(
      extractQuickSettingsSecurity(makeState({ tools: { exec: { security: " full " } } }))
        .execPolicy,
    ).toBe("full");
    expect(
      extractQuickSettingsSecurity(makeState({ tools: { exec: { security: " " } } })).execPolicy,
    ).toBe("allowlist");
  });

  it("returns unknown sentinel when configForm is absent", () => {
    const result = extractQuickSettingsSecurity({} as AppViewState);
    expect(result).toEqual({
      gatewayAuth: "unknown",
      execPolicy: "unknown",
      deviceAuth: false,
    });
  });
});
