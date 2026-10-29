import { describe, expect, it, vi } from "vitest";
import {
  configIncludeOwnsAgentRoster,
  hasResolvedRosterBeforeMigrations,
} from "./agent-roster-provenance.js";
import { createSnapshot } from "./mutate.test-support.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.openclaw.js";

vi.unmock("../agents/agent-scope-config.js");

function snapshot(params: {
  parsed: unknown;
  sourceConfigBeforeMigrations: OpenClawConfig;
  agentRosterIncludeOwned?: boolean;
}): ConfigFileSnapshot {
  return {
    ...createSnapshot({ raw: "{}", sourceConfig: params.sourceConfigBeforeMigrations }),
    includedPaths: [],
    parsed: params.parsed,
    agentRosterIncludeOwned: params.agentRosterIncludeOwned === true,
    sourceConfigBeforeMigrations: params.sourceConfigBeforeMigrations,
  };
}

describe("agent roster include provenance", () => {
  it("recognizes an include at the entries boundary", () => {
    const value = snapshot({
      parsed: { agents: { entries: { $include: "./agents.json" } } },
      sourceConfigBeforeMigrations: { agents: { entries: { ops: {} } } },
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
