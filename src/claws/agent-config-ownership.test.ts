import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../config/types.agents.js";
import {
  digestClawOwnedAgentConfig,
  matchesClawAgentConfigDigest,
} from "./agent-config-ownership.js";
import { digestClawValue } from "./digest.js";

describe("Claw agent config ownership", () => {
  it("accepts an unchanged legacy full-config digest but cannot infer later operator-only edits", () => {
    const installed: AgentConfig = {
      id: "worker",
      workspace: "/tmp/worker",
      model: { primary: "acme/original" },
      subagents: { allowAgents: ["researcher"] },
    };
    const legacyDigest = digestClawValue(installed);

    expect(matchesClawAgentConfigDigest(installed, legacyDigest)).toBe(true);
    expect(
      matchesClawAgentConfigDigest(
        { ...installed, model: { primary: "acme/operator" } },
        legacyDigest,
      ),
    ).toBe(false);
    expect(
      matchesClawAgentConfigDigest({ ...installed, subagents: { allowAgents: [] } }, legacyDigest),
    ).toBe(false);

    const ownedDigest = digestClawOwnedAgentConfig(installed);
    expect(
      matchesClawAgentConfigDigest(
        {
          ...installed,
          model: { primary: "acme/operator" },
          subagents: { allowAgents: [] },
        },
        ownedDigest,
      ),
    ).toBe(true);
  });
});
