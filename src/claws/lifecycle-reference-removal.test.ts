import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pruneAgentConfig } from "../commands/agents.config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { digestClawAgentRemovalSurface } from "./lifecycle-config-removal.js";
import { planClawAgentReferenceRemoval } from "./lifecycle-reference-removal.js";

describe("planClawAgentReferenceRemoval", () => {
  it("retains every operator-owned reference when planning adopted-agent removal", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          heartbeat: { agentId: "work", every: "5m" },
          systemAgent: { agentId: "WORK" },
          subagents: { allowAgents: ["work", "home"] },
        },
        entries: {
          work: { workspace: "/work-ws" },
          home: {
            workspace: "/home-ws",
            subagents: { allowAgents: ["WORK", "home"] },
          },
        },
      },
      bindings: [
        { agentId: "work", match: { channel: "whatsapp" } },
        { agentId: "home", match: { channel: "telegram" } },
      ],
      broadcast: {
        strategy: "parallel",
        "peer-1": ["work", "home"],
        "peer-2": ["WORK"],
        "telegram:-100123": { agents: ["WORK", "home"], maxRounds: 2, maxTurns: 4 },
        "slack:C0123": { agents: ["work"], mentionGating: false },
      },
      hooks: {
        allowedAgentIds: ["*", "work", "home"],
        mappings: [
          { id: "work-hook", agentId: "WORK", action: "agent" },
          { id: "home-hook", agentId: "home", action: "agent" },
          { id: "default-hook", action: "agent" },
        ],
      },
      tools: { agentToAgent: { enabled: true, allow: ["WORK", "home"] } },
      talk: { agentId: "work", provider: "test-provider" },
    };
    const pruned = pruneAgentConfig(config, "work");
    const expectedReferences = [
      "agents.defaults.heartbeat.agentId",
      "agents.defaults.subagents.allowAgents[0]",
      "agents.defaults.systemAgent.agentId",
      "agents.entries.home.subagents.allowAgents[0]",
      "bindings[0]",
      "broadcast.peer-1[0]",
      "broadcast.peer-2[0]",
      "broadcast.slack:C0123.agents[0]",
      "broadcast.telegram:-100123.agents[0]",
      "hooks.allowedAgentIds[1]",
      "hooks.mappings[0]",
      "talk.agentId",
      "tools.agentToAgent.allow[0]",
    ];
    expect(pruned.removedReferences).toEqual(expectedReferences);

    const plan = planClawAgentReferenceRemoval({
      agentId: "work",
      pruned,
      adopted: true,
      modified: false,
    });

    expect(plan.blockers).toEqual([
      {
        code: "adopted_agent_referenced",
        message: `Agent "work" is still referenced by ${expectedReferences.join(", ")}; reassign or remove those references, then run remove --dry-run again.`,
      },
    ]);
    expect(plan.actions.filter((action) => action.action !== "set")).toEqual([
      expect.objectContaining({
        kind: "configBinding",
        target: "bindings[agentId=work]",
        action: "retain",
        blocked: true,
        details: { count: 1 },
      }),
      expect.objectContaining({
        kind: "agentAllow",
        target: "tools.agentToAgent.allow[work]",
        action: "retain",
        blocked: true,
        details: { count: 1 },
      }),
      ...expectedReferences
        .filter((target) => target !== "bindings[0]" && target !== "tools.agentToAgent.allow[0]")
        .map((target) =>
          expect.objectContaining({
            kind: "configReference",
            target,
            action: "retain",
            blocked: true,
            details: { agentId: "work" },
          }),
        ),
    ]);
  });

  it("previews config values inserted to preserve a survivor during roster collapse", () => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { workspace: "/srv/fleet" },
        entries: { ops: {}, research: {} },
      },
    };
    const pruned = pruneAgentConfig(config, "ops");

    expect(pruned.config.agents?.entries).toEqual({
      research: { workspace: resolve("/srv/fleet/research") },
    });
    expect(pruned.removedReferences).toEqual([]);
    expect(pruned.removedConfig).toEqual(["agents.ownership"]);
    expect(pruned.insertedConfig).toEqual([
      { path: "agents.defaults.authInheritance.agentId", value: "main" },
      { path: "agents.entries.research.workspace", value: resolve("/srv/fleet/research") },
    ]);

    const plan = planClawAgentReferenceRemoval({
      agentId: "ops",
      pruned,
      adopted: false,
      modified: false,
    });

    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: "configReference",
        action: "remove",
        target: "agents.ownership",
        blocked: false,
        details: { agentId: "ops" },
      }),
      expect.objectContaining({
        kind: "configReference",
        action: "set",
        target: "agents.defaults.authInheritance.agentId",
        blocked: false,
        details: { agentId: "ops", value: "main" },
      }),
      expect.objectContaining({
        kind: "configReference",
        action: "set",
        target: "agents.entries.research.workspace",
        blocked: false,
        details: { agentId: "ops", value: resolve("/srv/fleet/research") },
      }),
    ]);
    expect(digestClawAgentRemovalSurface(config, "ops")).not.toBe(
      digestClawAgentRemovalSurface(
        {
          ...config,
          agents: {
            ...config.agents,
            defaults: { ...config.agents?.defaults, workspace: "/srv/other-fleet" },
          },
        },
        "ops",
      ),
    );
  });

  it("digests an explicit main survivor workspace", () => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { workspace: "C:/fleet-a" },
        entries: { main: {}, worker: {} },
      },
    };

    expect(digestClawAgentRemovalSurface(config, "worker")).not.toBe(
      digestClawAgentRemovalSurface(
        {
          ...config,
          agents: {
            ...config.agents,
            defaults: { ...config.agents?.defaults, workspace: "C:/fleet-b" },
          },
        },
        "worker",
      ),
    );
  });

  it("previews and digests ownership materialized for a surviving multi-agent roster", () => {
    const config: OpenClawConfig = {
      agents: { entries: { ops: {}, research: {}, writer: {} } },
    };
    const pruned = pruneAgentConfig(config, "ops");

    expect(pruned.config.agents?.ownership).toBe("explicit");
    expect(pruned.removedReferences).toEqual([]);
    expect(pruned.removedConfig).toEqual([]);
    expect(pruned.insertedConfig).toEqual([{ path: "agents.ownership", value: "explicit" }]);

    const plan = planClawAgentReferenceRemoval({
      agentId: "ops",
      pruned,
      adopted: true,
      modified: false,
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "configReference",
        action: "set",
        target: "agents.ownership",
        blocked: false,
        details: { agentId: "ops", value: "explicit" },
      }),
    );
    expect(digestClawAgentRemovalSurface(config, "ops")).not.toBe(
      digestClawAgentRemovalSurface(
        {
          ...config,
          agents: { entries: { ops: {}, research: {} } },
        },
        "ops",
      ),
    );
  });

  it("previews and digests the owner inserted when removing a sole fixed-store agent", () => {
    const config: OpenClawConfig = {
      session: { store: "/srv/shared-sessions.sqlite" },
      agents: { entries: { ops: {} } },
    };
    const pruned = pruneAgentConfig(config, "ops");

    expect(pruned.config.agents?.defaults?.sessionStore?.agentId).toBe("ops");
    expect(pruned.removedReferences).toEqual([]);
    expect(pruned.removedConfig).toEqual([]);
    expect(pruned.insertedConfig).toEqual([
      { path: "agents.defaults.sessionStore.agentId", value: "ops" },
    ]);

    const plan = planClawAgentReferenceRemoval({
      agentId: "ops",
      pruned,
      adopted: false,
      modified: false,
    });

    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "configReference",
        action: "set",
        target: "agents.defaults.sessionStore.agentId",
        blocked: false,
        details: { agentId: "ops", value: "ops" },
      }),
    );
    expect(digestClawAgentRemovalSurface(config, "ops")).not.toBe(
      digestClawAgentRemovalSurface(
        {
          ...config,
          session: { store: "/srv/sessions/{agentId}.sqlite" },
        },
        "ops",
      ),
    );
  });

  it("digests complete config objects that removal would delete", () => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { heartbeat: { agentId: "ops", every: "5m" } },
        entries: { ops: {}, research: {}, writer: {} },
      },
      hooks: { mappings: [{ id: "audit", action: "agent", agentId: "ops" }] },
    };
    const originalDigest = digestClawAgentRemovalSurface(config, "ops");

    expect(originalDigest).not.toBe(
      digestClawAgentRemovalSurface(
        {
          ...config,
          hooks: {
            mappings: [{ id: "replacement", action: "agent", agentId: "ops" }],
          },
        },
        "ops",
      ),
    );
    expect(originalDigest).not.toBe(
      digestClawAgentRemovalSurface(
        {
          ...config,
          agents: {
            ...config.agents,
            defaults: { heartbeat: { agentId: "ops", every: "1h" } },
          },
        },
        "ops",
      ),
    );
  });
});
