// Status overview value tests cover compact display values for agents, events, tasks, and services.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { theme } from "../../packages/terminal-core/src/theme.js";
import {
  buildStatusAllAgentsValue,
  buildStatusEventsValue,
  buildStatusPluginCompatibilityValue,
  buildStatusProbesValue,
  buildStatusSecretsValue,
  buildStatusSessionsOverviewValue,
} from "./status-overview-values.ts";

beforeEach(() => {
  vi.spyOn(theme, "success").mockImplementation((value) => `ok(${String(value)})`);
  vi.spyOn(theme, "warn").mockImplementation((value) => `warn(${String(value)})`);
  vi.spyOn(theme, "muted").mockImplementation((value) => `muted(${String(value)})`);
});
afterEach(() => vi.restoreAllMocks());

describe("status-overview-values", () => {
  it("counts active agents and formats status-all agent value", () => {
    const agentStatus = {
      bootstrapPendingCount: 2,
      totalSessions: 3,
      agents: [
        { id: "main", lastActiveAgeMs: 5_000 },
        { id: "ops", lastActiveAgeMs: 11 * 60_000 },
        { id: "idle", lastActiveAgeMs: null },
      ],
    };

    expect(buildStatusAllAgentsValue({ agentStatus })).toBe(
      "3 total · 2 bootstrapping · 1 active · 3 sessions",
    );
  });

  it("formats secrets events probes and plugin compatibility values", () => {
    expect(buildStatusSecretsValue(0)).toBe("none");
    expect(buildStatusSecretsValue(1)).toBe("1 diagnostic");
    expect(buildStatusEventsValue({ queuedSystemEvents: [] })).toBe("none");
    expect(buildStatusEventsValue({ queuedSystemEvents: ["a", "b"] })).toBe("2 queued");
    expect(
      buildStatusProbesValue({
        health: undefined,
      }),
    ).toBe("muted(skipped (use --deep))");
    expect(
      buildStatusPluginCompatibilityValue({
        notices: [{ pluginId: "a" }, { pluginId: "a" }, { pluginId: "b" }],
      }),
    ).toBe("warn(3 notices · 2 plugins)");
  });

  it("formats sessions overview values", () => {
    expect(
      buildStatusSessionsOverviewValue({
        sessions: {
          count: 2,
          paths: ["store.json", "other.json"],
          defaults: { model: "gpt-5.5", contextTokens: 12_000 },
        },
      }),
    ).toBe("2 stored · default gpt-5.5 (12k ctx) · 2 stores");
    expect(
      buildStatusSessionsOverviewValue({
        sessions: { count: 0, paths: [], defaults: {} },
      }),
    ).toBe("0 stored · default unknown · unknown");
  });
});
