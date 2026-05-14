import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __testing as setupRegistryRuntimeTesting } from "../plugins/setup-registry.runtime.js";
import { resolveAgentRuntimeLabel } from "./agent-runtime-label.js";

describe("resolveAgentRuntimeLabel", () => {
  beforeEach(() => {
    setupRegistryRuntimeTesting.resetRuntimeState();
    setupRegistryRuntimeTesting.setRuntimeModuleForTest({
      resolvePluginSetupCliBackend: ({ backend }) =>
        backend === "claude-cli"
          ? {
              pluginId: "anthropic",
              backend: { id: "claude-cli", config: { command: "claude" } },
            }
          : undefined,
    });
  });

  afterEach(() => {
    setupRegistryRuntimeTesting.resetRuntimeState();
  });

  it("uses the default `isCliProvider` lookup when no override is supplied", () => {
    const label = resolveAgentRuntimeLabel({
      sessionEntry: { modelProvider: "claude-cli" },
      fallbackProvider: "claude-cli",
    });
    expect(label).toBe("Claude CLI");
  });

  it("uses the supplied `isCliProviderOverride` instead of the default lookup", () => {
    // Hot-loop callers (e.g. `getStatusSummary`'s session-row build) pass a
    // precomputed `(provider) → boolean` memo so each label resolution does
    // not re-enter the setup-manifest discovery path. The override must
    // short-circuit the default lookup entirely so plugin-runtime state is
    // not read for every row.
    const override = vi.fn((provider: string) => provider === "shadow-cli");
    const label = resolveAgentRuntimeLabel({
      sessionEntry: { modelProvider: "shadow-cli" },
      fallbackProvider: "shadow-cli",
      isCliProviderOverride: override,
    });
    expect(label).toBe("shadow-cli (cli)");
    expect(override).toHaveBeenCalledWith("shadow-cli");
  });

  it("falls through to the default `pi` label when override returns false", () => {
    const override = vi.fn(() => false);
    const label = resolveAgentRuntimeLabel({
      sessionEntry: { modelProvider: "claude-cli" },
      fallbackProvider: "claude-cli",
      isCliProviderOverride: override,
    });
    expect(label).toBe("OpenClaw Pi Default");
    expect(override).toHaveBeenCalledWith("claude-cli");
  });
});
