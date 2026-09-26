import { describe, expect, it } from "vitest";
import { pruneAgentConfig } from "../commands/agents.config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { digestClawAgentRemovalSurface } from "./lifecycle-config-removal.js";
import { planClawAgentReferenceRemoval } from "./lifecycle-reference-removal.js";

describe("planClawAgentReferenceRemoval", () => {
  it("previews config values inserted to preserve a survivor during roster collapse", () => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { workspace: "/srv/fleet" },
        entries: { ops: {}, research: {} },
      },
    };
    const pruned = pruneAgentConfig(config, "ops");

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
        details: { agentId: "ops", value: expect.any(String) },
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
