// Subagent target policy tests cover requester defaults, explicit allowlists,
// wildcard target sets, and stale configured-agent filtering.
import { describe, expect, it } from "vitest";
import {
  describeSubagentSpawnTargetParameter,
  resolveRequesterSpawnTargetPolicy,
  resolveSubagentAllowedTargetIds,
  resolveSubagentSpawnTargetConfig,
} from "./subagent-target-policy.js";

// Admit an explicit `main` -> `target` spawn under the given allowlist.
function admit(
  allowAgents: string[] | undefined,
  target: string,
  configuredAgentIds: string[] = [],
) {
  return resolveRequesterSpawnTargetPolicy({
    cfg: { agents: { entries: { main: { subagents: { allowAgents } } } } },
    requesterAgentId: "main",
    targetAgentId: target,
    requestedAgentId: target,
    configuredAgentIds,
  });
}

describe("subagent target policy", () => {
  it("defaults to requester-only when no allowlist is configured", () => {
    expect(admit(undefined, "main")).toEqual({ ok: true });
    expect(admit(undefined, "other")).toEqual({
      ok: false,
      error: "agentId is not allowed for sessions_spawn (allowed: main)",
    });
  });

  it("filters explicit allowlists to configured target ids", () => {
    expect(
      resolveSubagentAllowedTargetIds({
        requesterAgentId: "main",
        allowAgents: ["planner", "stale"],
        configuredAgentIds: ["main", "planner"],
      }),
    ).toEqual({
      allowAny: false,
      allowedIds: ["planner"],
      explicitAllowlistConfigured: true,
    });

    expect(admit(["planner", "stale"], "stale", ["main", "planner"])).toEqual({
      ok: false,
      error: 'agentId "stale" is not in the configured agent registry (allowed: planner)',
    });
  });

  it("limits wildcard allowlists to configured agents plus the requester", () => {
    expect(
      resolveSubagentAllowedTargetIds({
        requesterAgentId: "main",
        allowAgents: ["*"],
        configuredAgentIds: ["planner", "checker"],
      }),
    ).toEqual({
      allowAny: true,
      allowedIds: ["checker", "main", "planner"],
      explicitAllowlistConfigured: true,
    });
  });

  it("filters explicit targets when wildcard allowlists are mixed", () => {
    expect(
      resolveSubagentAllowedTargetIds({
        requesterAgentId: "main",
        allowAgents: ["*", "beta"],
        configuredAgentIds: ["main", "planner"],
      }),
    ).toEqual({
      allowAny: true,
      allowedIds: ["main", "planner"],
      explicitAllowlistConfigured: true,
    });

    expect(admit(["*", "beta"], "beta", ["main", "planner"])).toEqual({
      ok: false,
      error: 'agentId "beta" is not in the configured agent registry (allowed: main, planner)',
    });
  });

  it("describes the requester-only default target", () => {
    expect(
      describeSubagentSpawnTargetParameter({
        requesterAgentId: "main",
      }),
    ).toBe(
      "Only the requester agent is allowed as a target; no other agentId is configured. " +
        'Omit to keep the requester agent ("main").',
    );
  });

  it("describes an explicit allowlist target", () => {
    expect(
      describeSubagentSpawnTargetParameter({
        requesterAgentId: "main",
        allowAgents: ["main", "planner"],
        configuredAgentIds: ["main", "planner"],
      }),
    ).toBe('Configured agent to target: main, planner. Omit to keep the requester agent ("main").');
  });

  it("describes a wildcard allowlist target", () => {
    expect(
      describeSubagentSpawnTargetParameter({
        requesterAgentId: "main",
        allowAgents: ["*"],
        configuredAgentIds: ["main", "planner"],
      }),
    ).toBe(
      "Configured agent to target; any configured agent is allowed. " +
        'Omit to keep the requester agent ("main").',
    );
  });

  it("describes an explicitly empty allowlist without implying the requester id works", () => {
    const description = describeSubagentSpawnTargetParameter({
      requesterAgentId: "main",
      allowAgents: [],
      configuredAgentIds: ["main"],
    });
    expect(description).toBe(
      "No agentId is allowed as an explicit target; the configured allowlist is empty. " +
        'Omit to keep the requester agent ("main").',
    );
    expect(admit([], "main", ["main"]).ok).toBe(false);
  });
  it("tells the model an explicit agentId is required when requireAgentId is set", () => {
    expect(
      describeSubagentSpawnTargetParameter({
        requesterAgentId: "main",
        allowAgents: ["main", "planner"],
        configuredAgentIds: ["main", "planner"],
        requireAgentId: true,
      }),
    ).toBe(
      'Configured agent to target: main, planner. agentId is required; the requester agent is "main".',
    );
  });

  it("names the collector default agent used when collect=true omits agentId", () => {
    expect(
      describeSubagentSpawnTargetParameter({
        requesterAgentId: "main",
        allowAgents: ["main", "planner"],
        configuredAgentIds: ["main", "planner"],
        collectDefaultAgentId: "planner",
      }),
    ).toBe(
      'Configured agent to target: main, planner. Omit to keep the requester agent ("main"). ' +
        'With collect=true, omit to target tools.swarm.defaultAgentId ("planner").',
    );
  });

  it("requires agentId for collect=true when the collector default is not allowed", () => {
    const description = describeSubagentSpawnTargetParameter({
      requesterAgentId: "main",
      configuredAgentIds: ["main", "planner"],
      collectDefaultAgentId: "planner",
    });
    expect(description).toContain(
      'With collect=true, agentId is required; tools.swarm.defaultAgentId ("planner") is not an allowed target.',
    );
  });

  it("limits guidance to the requester for a sender-restricted session", () => {
    const description = describeSubagentSpawnTargetParameter({
      requesterAgentId: "main",
      allowAgents: ["planner"],
      configuredAgentIds: ["main", "planner"],
      collectDefaultAgentId: "planner",
      inheritedToolPolicySource: "sender",
    });
    expect(description).toBe(
      "Sender policy allows only hidden helpers of the requester agent; no other agentId is allowed. " +
        'Omit to keep the requester agent ("main"). ' +
        'With collect=true, agentId is required; tools.swarm.defaultAgentId ("planner") is not an allowed target.',
    );
    expect(description).not.toContain("Configured agent to target");
  });

  it("lists up to 20 targets and says when more are not listed", () => {
    const describeIds = (count: number) => {
      const ids = Array.from({ length: count }, (_, i) => `agent-${String(i).padStart(2, "0")}`);
      return describeSubagentSpawnTargetParameter({
        requesterAgentId: "agent-00",
        allowAgents: ids,
        configuredAgentIds: ids,
      });
    };
    const listed = Array.from({ length: 20 }, (_, i) => `agent-${String(i).padStart(2, "0")}`);
    expect(describeIds(20)).toBe(
      `Configured agent to target: ${listed.join(", ")}. Omit to keep the requester agent ("agent-00").`,
    );
    expect(describeIds(21)).toBe(
      `Configured agent to target: ${listed.join(", ")} (+1). Only the first 20 ids are listed. ` +
        'Omit to keep the requester agent ("agent-00").',
    );
  });

  it("keeps the description bounded for a very large allowlist", () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `agent-${i}`);
    const description = describeSubagentSpawnTargetParameter({
      requesterAgentId: "main",
      allowAgents: ids,
      configuredAgentIds: ids,
    });
    expect(description.length).toBeLessThan(1000);
    expect(description).toContain("(+4980). Only the first 20 ids are listed.");
    expect(description).not.toContain("agents_list");
  });

  it("checks a target against the requester's requireAgentId and allowAgents", () => {
    const cfg = {
      agents: {
        entries: { main: { subagents: { allowAgents: ["planner"], requireAgentId: true } } },
      },
    };
    const base = { cfg, requesterAgentId: "main", configuredAgentIds: ["main", "planner"] };
    expect(resolveRequesterSpawnTargetPolicy({ ...base, targetAgentId: "planner" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("requires explicit agentId"),
    });
    expect(
      resolveRequesterSpawnTargetPolicy({
        ...base,
        targetAgentId: "planner",
        requestedAgentId: "planner",
      }),
    ).toEqual({ ok: true });
    expect(
      resolveRequesterSpawnTargetPolicy({
        ...base,
        targetAgentId: "main",
        requestedAgentId: "main",
      }),
    ).toEqual({ ok: false, error: expect.stringContaining("not allowed") });
  });

  it("resolves spawn target settings from the agent override, then defaults", () => {
    const cfg = {
      agents: {
        defaults: { subagents: { allowAgents: ["main"], requireAgentId: true } },
        entries: {
          main: {},
          lead: { subagents: { allowAgents: ["main", "lead"], requireAgentId: false } },
        },
      },
    };
    expect(resolveSubagentSpawnTargetConfig(cfg, "main")).toEqual({
      allowAgents: ["main"],
      requireAgentId: true,
    });
    expect(resolveSubagentSpawnTargetConfig(cfg, "lead")).toEqual({
      allowAgents: ["main", "lead"],
      requireAgentId: false,
    });
    // Each field falls back on its own: an override of one keeps the default of the other.
    expect(
      resolveSubagentSpawnTargetConfig(
        {
          agents: {
            defaults: { subagents: { requireAgentId: true } },
            entries: { main: { subagents: { allowAgents: ["*"] } } },
          },
        },
        "main",
      ),
    ).toEqual({ allowAgents: ["*"], requireAgentId: true });
    expect(resolveSubagentSpawnTargetConfig({}, "main")).toEqual({
      allowAgents: undefined,
      requireAgentId: false,
    });
  });
});
