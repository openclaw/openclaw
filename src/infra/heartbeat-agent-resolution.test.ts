import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { tryResolveAmbientHeartbeatAgentId } from "./heartbeat-agent-resolution.js";
import { isHeartbeatOwnerUnresolved, resolveHeartbeatAgents } from "./heartbeat-config.js";
import { isHeartbeatEnabledForAgent } from "./heartbeat-summary.js";

describe("tryResolveAmbientHeartbeatAgentId", () => {
  it.each([
    {
      name: "explicit heartbeat owner",
      cfg: {
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: {} },
          defaults: {
            heartbeat: { agentId: "ops" },
            systemAgent: { agentId: "main" },
          },
        },
      } as OpenClawConfig,
      expected: "ops",
    },
    {
      name: "system owner",
      cfg: {
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: {} },
          defaults: { systemAgent: { agentId: "ops" } },
        },
      } as OpenClawConfig,
      expected: "ops",
    },
    {
      name: "sole agent",
      cfg: {
        agents: { ownership: "explicit", entries: { solo: {} } },
      } as OpenClawConfig,
      expected: "solo",
    },
    {
      name: "ownerless explicit multi-agent roster",
      cfg: {
        agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
      } as OpenClawConfig,
      expected: undefined,
    },
  ])("resolves the $name", ({ cfg, expected }) => {
    expect(tryResolveAmbientHeartbeatAgentId(cfg)).toBe(expected);
  });
});

describe("resolveHeartbeatAgents", () => {
  const systemOwnedConfig = {
    agents: {
      ownership: "explicit",
      entries: { ops: {}, main: {} },
      defaults: { systemAgent: { agentId: "ops" } },
    },
  } as OpenClawConfig;
  const ownerlessConfig = {
    agents: { ownership: "explicit", entries: { ops: {}, main: {} } },
  } as OpenClawConfig;

  it("enrolls the system agent when ambient heartbeat config is absent", () => {
    expect(resolveHeartbeatAgents(systemOwnedConfig)).toEqual([
      { agentId: "ops", heartbeat: undefined },
    ]);
    expect(isHeartbeatEnabledForAgent(systemOwnedConfig, "ops")).toBe(true);
    expect(isHeartbeatEnabledForAgent(systemOwnedConfig, "main")).toBe(false);
    expect(isHeartbeatOwnerUnresolved(systemOwnedConfig)).toBe(false);
  });

  it("disables ambient heartbeats when an explicit multi-agent roster has no owner", () => {
    expect(resolveHeartbeatAgents(ownerlessConfig)).toEqual([]);
    expect(isHeartbeatEnabledForAgent(ownerlessConfig)).toBe(false);
    expect(isHeartbeatEnabledForAgent(ownerlessConfig, "ops")).toBe(false);
    expect(isHeartbeatOwnerUnresolved(ownerlessConfig)).toBe(true);
  });

  it.each([
    { name: "system owner", cfg: systemOwnedConfig, expectedAgentIds: ["ops"] },
    {
      name: "explicit heartbeat owner",
      cfg: {
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: {} },
          defaults: { heartbeat: { agentId: "ops" } },
        },
      } as OpenClawConfig,
      expectedAgentIds: ["ops"],
    },
    {
      name: "legacy default marker",
      cfg: {
        agents: { entries: { main: { default: true }, ops: {} } },
      } as OpenClawConfig,
      expectedAgentIds: ["main"],
    },
    {
      name: "sole agent",
      cfg: { agents: { ownership: "explicit", entries: { solo: {} } } } as OpenClawConfig,
      expectedAgentIds: ["solo"],
    },
    {
      name: "per-agent heartbeat entries",
      cfg: {
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: { heartbeat: { every: "30m" } } },
        },
      } as OpenClawConfig,
      expectedAgentIds: ["ops"],
    },
    {
      name: "per-agent enrollment takes precedence over the default heartbeat owner",
      cfg: {
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: { heartbeat: { every: "30m" } } },
          defaults: { heartbeat: { agentId: "main" } },
        },
      } as OpenClawConfig,
      expectedAgentIds: ["ops"],
    },
    {
      name: "broadcast heartbeat defaults",
      cfg: {
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: {} },
          defaults: { heartbeat: { every: "30m" } },
        },
      } as OpenClawConfig,
      expectedAgentIds: ["main", "ops"],
    },
  ])("enrolls exactly the runnable agents for the $name config", ({ cfg, expectedAgentIds }) => {
    const agents = resolveHeartbeatAgents(cfg);
    expect(agents.map((agent) => agent.agentId)).toEqual(expectedAgentIds);
    for (const agentId of Object.keys(cfg.agents?.entries ?? {})) {
      expect(isHeartbeatEnabledForAgent(cfg, agentId)).toBe(expectedAgentIds.includes(agentId));
    }
  });

  it.each([
    ["entries", "explicit"],
    ["entries", "defaults"],
    ["list", "explicit"],
    ["list", "defaults"],
  ] as const)("enrolls a %s %s fleet with linear reads and fresh config", (form, enrollment) => {
    const size = 64;
    const rows = Array.from({ length: size }, (_, index) => ({
      id: `agent-${index}`,
      ...(enrollment === "explicit" ? { heartbeat: { every: "45m" } } : {}),
    }));
    const entries = Object.fromEntries(rows.map(({ id, ...entry }) => [id, entry]));
    let reads = 0;
    const observe = <T extends object>(roster: T): T =>
      new Proxy(roster, {
        get(target, key, receiver) {
          if (typeof key === "string" && (key.startsWith("agent-") || /^\d+$/.test(key))) {
            reads += 1;
          }
          return Reflect.get(target, key, receiver);
        },
      });
    const defaults = { heartbeat: { every: "30m", target: "owner" as const } };
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults,
        ...(form === "entries" ? { entries: observe(entries) } : { list: observe(rows) }),
      },
    };
    const expected = rows.map(({ id }) => ({
      agentId: id,
      heartbeat: { every: enrollment === "explicit" ? "45m" : "30m", target: "owner" },
    }));

    expect(resolveHeartbeatAgents(cfg)).toEqual(expected);
    // Bound actual entry reads, allowing several passes while rejecting a scan per agent.
    expect(reads).toBeLessThanOrEqual(size * 4);

    defaults.heartbeat.every = "20m";
    if (form === "entries") {
      delete entries[`agent-${size - 1}`];
    } else {
      rows.pop();
    }
    reads = 0;
    expect(resolveHeartbeatAgents(cfg)).toEqual(
      expected.slice(0, -1).map(({ agentId }) => ({
        agentId,
        heartbeat: { every: enrollment === "explicit" ? "45m" : "20m", target: "owner" },
      })),
    );
    expect(reads).toBeLessThanOrEqual(size * 4);
  });
});
