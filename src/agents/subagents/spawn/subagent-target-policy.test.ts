import { describe, expect, it } from "vitest";
import {
  describeSubagentSpawnTargetParameter,
  resolveRequesterSpawnTargetPolicy,
  resolveSubagentAllowedTargetIds,
  resolveSubagentSpawnTargetConfig,
} from "./subagent-target-policy.js";

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
  it.each([
    {
      allowAgents: ["*"],
      error:
        'agentId "nova" is not in the configured agent registry (allowed: main, mark). Did you mean agent id "main" (Nova)?',
    },
    { allowAgents: undefined, error: "agentId is not allowed for sessions_spawn (allowed: mark)" },
  ])(
    "suggests only an allowed agent id for a display name ($allowAgents)",
    ({ allowAgents, error }) => {
      expect(
        resolveRequesterSpawnTargetPolicy({
          cfg: {
            agents: {
              ownership: "explicit",
              entries: {
                main: { identity: { name: "Nova" } },
                mark: { subagents: { allowAgents } },
              },
            },
          },
          requesterAgentId: "mark",
          targetAgentId: "nova",
          requestedAgentId: "Nova",
          configuredAgentIds: ["main", "mark"],
        }),
      ).toEqual({ ok: false, error });
    },
  );

  it("defaults to requester-only when no allowlist is configured", () => {
    expect(admit(undefined, "main")).toEqual({ ok: true });
    expect(admit(undefined, "other")).toEqual({
      ok: false,
      error: "agentId is not allowed for sessions_spawn (allowed: main)",
    });
  });

  it.each([
    [["planner", "stale"], ["main", "planner"], false, ["planner"], "stale"],
    [["*"], ["planner", "checker"], true, ["checker", "main", "planner"], undefined],
    [["*", "beta"], ["main", "planner"], true, ["main", "planner"], "beta"],
  ] satisfies Array<[string[], string[], boolean, string[], string?]>)(
    "filters configured targets for %j",
    (allowAgents, configuredAgentIds, allowAny, allowedIds, rejected) => {
      expect(
        resolveSubagentAllowedTargetIds({
          requesterAgentId: "main",
          allowAgents,
          configuredAgentIds,
        }),
      ).toEqual({ allowAny, allowedIds, explicitAllowlistConfigured: true });
      if (rejected) {
        expect(admit(allowAgents, rejected, configuredAgentIds)).toEqual({
          ok: false,
          error: `agentId "${rejected}" is not in the configured agent registry (allowed: ${allowedIds.join(", ")})`,
        });
      }
    },
  );

  const omitMain = 'Omit to keep the requester agent ("main").';
  const both = ["main", "planner"];
  it.each([
    ["the sole agent with no constraint", {}, undefined],
    [
      "requester-only default with other agents configured",
      { configuredAgentIds: both },
      `Only the requester agent is allowed as a target. ${omitMain}`,
    ],
    [
      "a wildcard allowlist",
      { allowAgents: ["*"], configuredAgentIds: both },
      `Configured agent to target; any configured agent is allowed. ${omitMain}`,
    ],
    [
      "an explicitly empty allowlist",
      { allowAgents: [], configuredAgentIds: ["main"] },
      `No agentId is allowed as an explicit target; the configured allowlist is empty. ${omitMain}`,
    ],
    [
      "requireAgentId",
      { allowAgents: both, configuredAgentIds: both, requireAgentId: true },
      'Configured agent to target: main, planner. agentId is required; the requester agent is "main".',
    ],
    [
      "a sender-restricted session with a disallowed collector default",
      {
        allowAgents: ["planner"],
        configuredAgentIds: both,
        collectDefaultAgentId: "planner",
        inheritedToolPolicySource: "sender" as const,
      },
      "Sender policy allows only hidden helpers of the requester agent; no other agentId is allowed. " +
        `${omitMain} ` +
        'With collect=true, agentId is required; tools.swarm.defaultAgentId ("planner") is not an allowed target.',
    ],
  ])("describes %s", (_label, params, expected) => {
    expect(describeSubagentSpawnTargetParameter({ requesterAgentId: "main", ...params })).toBe(
      expected,
    );
  });

  it("rejects the requester id under an explicitly empty allowlist", () => {
    expect(admit([], "main", ["main"]).ok).toBe(false);
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
  });
});
