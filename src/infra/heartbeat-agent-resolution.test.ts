import { afterEach, expect, it, vi } from "vitest";
import * as agentScopeConfig from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { tryResolveAmbientHeartbeatAgentId } from "./heartbeat-agent-resolution.js";
import { isHeartbeatOwnerUnresolved, resolveHeartbeatAgents } from "./heartbeat-config.js";
import { isHeartbeatEnabledForAgent } from "./heartbeat-summary.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function roster(
  defaults?: NonNullable<OpenClawConfig["agents"]>["defaults"],
  entries: NonNullable<OpenClawConfig["agents"]>["entries"] = { main: {}, ops: {} },
): OpenClawConfig {
  return { agents: { ownership: "explicit", entries, ...(defaults ? { defaults } : {}) } };
}

function fleetEntries(size: number, every?: string) {
  return Object.fromEntries(
    Array.from({ length: size }, (_, i) => [`agent-${i}`, every ? { heartbeat: { every } } : {}]),
  );
}

function expectedFleet(size: number, every: string) {
  return Array.from({ length: size }, (_, i) => ({
    agentId: `agent-${i}`,
    heartbeat: { every, target: "owner" },
  }));
}

const systemOwnedConfig = roster({ systemAgent: { agentId: "ops" } }, { ops: {}, main: {} });
const ownerlessConfig = roster(undefined, { ops: {}, main: {} });

it.each([false, true])("checks enrollment without hydration (frozen=%s)", (frozen) => {
  const size = 512;
  const cfg = roster(undefined, fleetEntries(size, "0m"));
  if (frozen) {
    freezeJsonSnapshot(cfg);
    resolveHeartbeatAgents(cfg);
  }
  const hydrate = vi.spyOn(agentScopeConfig, "resolveAgentConfig");
  const lastAgentId = `agent-${size - 1}`;

  expect(isHeartbeatEnabledForAgent(cfg, lastAgentId)).toBe(true);
  const firstCheckHydrations = hydrate.mock.calls.length;
  expect(isHeartbeatEnabledForAgent(cfg, "missing")).toBe(false);
  expect(isHeartbeatEnabledForAgent(ownerlessConfig, lastAgentId)).toBe(false);
  expect(isHeartbeatEnabledForAgent(cfg, lastAgentId)).toBe(true);

  expect(firstCheckHydrations).toBe(0);
});

it("refreshes membership after mutable heartbeat enrollment changes", () => {
  const entries: Record<string, { heartbeat?: { every: string } }> = {
    main: {},
    ops: { heartbeat: { every: "0m" } },
  };
  const cfg = roster(undefined, entries);
  expect(isHeartbeatEnabledForAgent(cfg, "ops")).toBe(true);
  entries.ops = { heartbeat: undefined };
  expect(isHeartbeatEnabledForAgent(cfg, "ops")).toBe(false);
  entries.ops = { heartbeat: { every: "5m" } };
  expect(isHeartbeatEnabledForAgent(cfg, "ops")).toBe(true);
});

it("preserves explicit roster order and duplicate IDs with the first normalized config", () => {
  const cfg = roster(
    { heartbeat: { agentId: "main", target: "owner" } },
    {
      OPS: { heartbeat: { every: "0m" } },
      ops: { heartbeat: { every: "5m" } },
      main: {},
    },
  );
  expect(resolveHeartbeatAgents(cfg)).toEqual([
    { agentId: "ops", heartbeat: { agentId: "main", target: "owner", every: "0m" } },
    { agentId: "ops", heartbeat: { agentId: "main", target: "owner", every: "0m" } },
  ]);
  expect(isHeartbeatEnabledForAgent(cfg, "OPS")).toBe(true);
  expect(isHeartbeatEnabledForAgent(cfg, "main")).toBe(false);
});

it.each([
  ["system agent", systemOwnedConfig, ["ops"]],
  ["ownerless roster", ownerlessConfig, []],
  [
    "explicit heartbeat owner",
    roster({ heartbeat: { agentId: "ops" }, systemAgent: { agentId: "main" } }),
    ["ops"],
  ],
  [
    "migrated legacy default marker",
    createCanonicalAgentConfigFixture({
      agents: { entries: { main: { default: true }, ops: {} } },
    }).config,
    ["main"],
  ],
  ["sole agent", roster(undefined, { solo: {} }), ["solo"]],
  [
    "per-agent enrollment overrides the default owner",
    roster({ heartbeat: { agentId: "main" } }, { main: {}, ops: { heartbeat: { every: "30m" } } }),
    ["ops"],
  ],
  ["broadcast heartbeat defaults", roster({ heartbeat: { every: "30m" } }), ["main", "ops"]],
] satisfies [string, OpenClawConfig, string[]][])(
  "enrolls exactly the runnable agents for the %s config",
  (name, cfg, expectedAgentIds) => {
    const agents = resolveHeartbeatAgents(cfg);
    if (name === "explicit heartbeat owner") {
      expect(tryResolveAmbientHeartbeatAgentId(cfg)).toBe("ops");
    } else if (name === "system agent") {
      expect(agents).toEqual([{ agentId: "ops", heartbeat: undefined }]);
      expect(isHeartbeatOwnerUnresolved(cfg)).toBe(false);
    } else if (name === "ownerless roster") {
      expect(agents).toEqual([]);
      expect(isHeartbeatEnabledForAgent(cfg)).toBe(false);
      expect(isHeartbeatOwnerUnresolved(cfg)).toBe(true);
    }
    expect(agents.map((agent) => agent.agentId)).toEqual(expectedAgentIds);
    for (const agentId of Object.keys(cfg.agents?.entries ?? {})) {
      expect(isHeartbeatEnabledForAgent(cfg, agentId)).toBe(expectedAgentIds.includes(agentId));
    }
  },
);

it.each(["explicit", "defaults"] as const)("enrolls %s fleets linearly", (enrollment) => {
  const size = 64;
  const explicit = enrollment === "explicit";
  const entries = fleetEntries(size, explicit ? "45m" : undefined);
  let reads = 0;
  const observe = <T extends object>(entriesToObserve: T): T =>
    new Proxy(entriesToObserve, {
      get(target, key, receiver) {
        if (typeof key === "string" && (key.startsWith("agent-") || /^\d+$/.test(key))) {
          reads += 1;
        }
        return Reflect.get(target, key, receiver);
      },
    });
  const defaults = { heartbeat: { every: "30m", target: "owner" as const } };
  const cfg = roster(defaults, observe(entries));
  expect(resolveHeartbeatAgents(cfg)).toEqual(expectedFleet(size, explicit ? "45m" : "30m"));
  // Bound actual entry reads, allowing several passes while rejecting a scan per agent.
  expect(reads).toBeLessThanOrEqual(size * 4);

  defaults.heartbeat.every = "20m";
  delete entries[`agent-${size - 1}`];
  reads = 0;
  expect(resolveHeartbeatAgents(cfg)).toEqual(expectedFleet(size - 1, explicit ? "45m" : "20m"));
  expect(reads).toBeLessThanOrEqual(size * 4);
});
