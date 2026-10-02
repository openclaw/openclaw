import { describe, expect, it, vi } from "vitest";
import {
  configIncludeOwnsAgentRoster,
  hasResolvedRosterBeforeMigrations,
} from "./agent-roster-provenance.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.openclaw.js";

vi.unmock("../agents/agent-scope-config.js");

function snapshot(params: {
  parsed: unknown;
  sourceConfigBeforeMigrations: OpenClawConfig;
  agentRosterIncludeOwned?: boolean;
}): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.json",
    includedPaths: [],
    exists: true,
    raw: "{}",
    parsed: params.parsed,
    agentRosterIncludeOwned: params.agentRosterIncludeOwned === true,
    sourceConfigBeforeMigrations: params.sourceConfigBeforeMigrations,
    sourceConfig: params.sourceConfigBeforeMigrations,
    resolved: params.sourceConfigBeforeMigrations,
    runtimeConfig: params.sourceConfigBeforeMigrations,
    config: params.sourceConfigBeforeMigrations,
    valid: true,
    issues: [],
    warnings: [],
    legacyIssues: [],
  } as ConfigFileSnapshot;
}

describe("agent roster include provenance", () => {
  it("recognizes an include at the entries boundary", () => {
    const value = snapshot({
      parsed: { agents: { entries: { $include: "./agents.json" } } },
      sourceConfigBeforeMigrations: { agents: { entries: { ops: { default: true } } } },
    });

    expect(configIncludeOwnsAgentRoster(value)).toBe(true);
  });

  it("recognizes an empty include at the entries boundary", () => {
    const value = snapshot({
      parsed: { agents: { entries: { $include: "./empty-roster.json" } } },
      sourceConfigBeforeMigrations: { agents: { entries: {} } },
    });

    expect(configIncludeOwnsAgentRoster(value)).toBe(true);
  });

  it("recognizes an included empty roster", () => {
    const value = snapshot({
      parsed: { $include: "./base.json" },
      sourceConfigBeforeMigrations: { agents: { entries: {} } },
      agentRosterIncludeOwned: true,
    });

    expect(hasResolvedRosterBeforeMigrations(value)).toBe(false);
    expect(configIncludeOwnsAgentRoster(value)).toBe(true);
  });
});
