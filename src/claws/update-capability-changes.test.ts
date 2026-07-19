import { describe, expect, it } from "vitest";
import {
  cronCapabilityChange,
  mcpCapabilityChange,
  pushResolvedAgentCapabilityChanges,
} from "./update-capability-changes.js";

type Changes = Parameters<typeof pushResolvedAgentCapabilityChanges>[0]["changes"];

function collectChanges(params: {
  currentAgent: Parameters<typeof pushResolvedAgentCapabilityChanges>[0]["desiredAgent"];
  desiredAgent: Parameters<typeof pushResolvedAgentCapabilityChanges>[0]["desiredAgent"];
  defaults?: NonNullable<
    Parameters<typeof pushResolvedAgentCapabilityChanges>[0]["config"]["agents"]
  >["defaults"];
}): Changes {
  const changes: Changes = [];
  pushResolvedAgentCapabilityChanges({
    changes,
    agentId: params.currentAgent.id,
    config: {
      agents: {
        defaults: params.defaults,
        list: [params.currentAgent],
      },
    },
    desiredAgent: params.desiredAgent,
  });
  return changes;
}

describe("pushResolvedAgentCapabilityChanges", () => {
  it("classifies effective sandbox and heartbeat changes", () => {
    const changes = collectChanges({
      currentAgent: { id: "worker", sandbox: { mode: "all" }, heartbeat: { every: "1h" } },
      desiredAgent: { id: "worker", sandbox: { mode: "off" }, heartbeat: { every: "5m" } },
    });
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "agent.sandbox.mode",
          classification: "escalation",
          requiresDistinctConsent: true,
        }),
        expect.objectContaining({
          path: "agent.heartbeat.every",
          classification: "escalation",
          requiresDistinctConsent: true,
        }),
      ]),
    );

    const inherited = collectChanges({
      currentAgent: { id: "worker", sandbox: { mode: "all" }, heartbeat: { every: "1h" } },
      desiredAgent: { id: "worker" },
      defaults: { sandbox: { mode: "off" }, heartbeat: { every: "5m" } },
    });
    expect(inherited).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "agent.sandbox.mode",
          classification: "escalation",
          requiresDistinctConsent: true,
          desired: expect.objectContaining({ summary: "off" }),
        }),
        expect.objectContaining({
          path: "agent.heartbeat.every",
          classification: "escalation",
          requiresDistinctConsent: true,
          current: expect.objectContaining({ summary: "1h" }),
          desired: expect.objectContaining({ summary: "5m" }),
        }),
      ]),
    );
  });

  it("resolves the implicit heartbeat interval", () => {
    const changes: Changes = [];
    pushResolvedAgentCapabilityChanges({
      changes,
      agentId: "main",
      config: {
        agents: { list: [{ id: "main", heartbeat: { every: "1h" } }] },
      },
      desiredAgent: { id: "main" },
    });
    expect(changes).toContainEqual(
      expect.objectContaining({
        path: "agent.heartbeat.every",
        classification: "escalation",
        requiresDistinctConsent: true,
        current: expect.objectContaining({ summary: "1h" }),
        desired: expect.objectContaining({ summary: "30m" }),
      }),
    );
  });

  it("preserves implicit default-agent heartbeat resolution", () => {
    const changes: Changes = [];
    pushResolvedAgentCapabilityChanges({
      changes,
      agentId: "worker",
      config: { agents: { list: [{ id: "worker" }, { id: "other" }] } },
      desiredAgent: { id: "worker" },
    });
    expect(changes.filter((change) => change.path.startsWith("agent.heartbeat."))).toEqual([]);
  });

  it("classifies heartbeat activity increases and reductions directionally", () => {
    const moreFrequent = collectChanges({
      currentAgent: { id: "worker", heartbeat: { every: "1h" } },
      desiredAgent: { id: "worker", heartbeat: { every: "5m" } },
    });
    expect(moreFrequent).toContainEqual(
      expect.objectContaining({
        path: "agent.heartbeat.every",
        classification: "escalation",
        requiresDistinctConsent: true,
      }),
    );

    const lessFrequent = collectChanges({
      currentAgent: {
        id: "worker",
        heartbeat: { every: "5m", isolatedSession: false, timeoutSeconds: 60 },
      },
      desiredAgent: {
        id: "worker",
        heartbeat: { every: "1h", isolatedSession: true, timeoutSeconds: 30 },
      },
    });
    expect(lessFrequent).toEqual(
      expect.arrayContaining(
        ["every", "isolatedSession", "timeoutSeconds"].map((field) =>
          expect.objectContaining({
            path: `agent.heartbeat.${field}`,
            classification: "reduction",
            requiresDistinctConsent: false,
          }),
        ),
      ),
    );

    const disabled = collectChanges({
      currentAgent: { id: "worker", heartbeat: { every: "5m" } },
      desiredAgent: { id: "worker", heartbeat: { every: "0m" } },
    });
    expect(disabled).toContainEqual(
      expect.objectContaining({
        path: "agent.heartbeat.every",
        classification: "reduction",
        requiresDistinctConsent: false,
      }),
    );
  });

  it("ranks sandbox mode and sharing scope", () => {
    const changes = collectChanges({
      currentAgent: { id: "worker", sandbox: { mode: "off", scope: "shared" } },
      desiredAgent: { id: "worker", sandbox: { mode: "all", scope: "session" } },
    });
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "agent.sandbox.mode",
          classification: "reduction",
          requiresDistinctConsent: false,
        }),
        expect.objectContaining({
          path: "agent.sandbox.scope",
          classification: "reduction",
          requiresDistinctConsent: false,
        }),
      ]),
    );

    const widened = collectChanges({
      currentAgent: { id: "worker", sandbox: { scope: "session" } },
      desiredAgent: { id: "worker", sandbox: { scope: "shared" } },
    });
    expect(widened).toContainEqual(
      expect.objectContaining({
        path: "agent.sandbox.scope",
        classification: "escalation",
        requiresDistinctConsent: true,
      }),
    );
  });

  it("classifies tool restrictions by effective set membership", () => {
    const substituted = collectChanges({
      currentAgent: { id: "worker", tools: { deny: ["exec"] } },
      desiredAgent: { id: "worker", tools: { deny: ["read", "write"] } },
    });
    expect(substituted).toContainEqual(
      expect.objectContaining({
        path: "agent.tools.deny",
        classification: "escalation",
        requiresDistinctConsent: true,
      }),
    );

    for (const field of ["allow", "deny"] as const) {
      const added = collectChanges({
        currentAgent: { id: "worker" },
        desiredAgent: { id: "worker", tools: { [field]: ["exec"] } },
      });
      expect(added).toContainEqual(
        expect.objectContaining({
          path: `agent.tools.${field}`,
          classification: "reduction",
          requiresDistinctConsent: false,
        }),
      );

      const removed = collectChanges({
        currentAgent: { id: "worker", tools: { [field]: ["exec"] } },
        desiredAgent: { id: "worker" },
      });
      expect(removed).toContainEqual(
        expect.objectContaining({
          path: `agent.tools.${field}`,
          classification: "escalation",
          requiresDistinctConsent: true,
        }),
      );
    }
  });

  it("treats tool policies on a restored missing agent as escalations", () => {
    for (const field of ["allow", "deny"] as const) {
      const changes: Changes = [];
      pushResolvedAgentCapabilityChanges({
        changes,
        agentId: "worker",
        config: { agents: { list: [] } },
        desiredAgent: { id: "worker", tools: { [field]: ["exec"] } },
      });
      expect(changes).toContainEqual(
        expect.objectContaining({
          path: `agent.tools.${field}`,
          classification: "escalation",
          requiresDistinctConsent: true,
        }),
      );
    }
  });

  it("treats inherited capabilities on a restored missing agent as escalations", () => {
    const changes: Changes = [];
    pushResolvedAgentCapabilityChanges({
      changes,
      agentId: "worker",
      config: {
        agents: {
          defaults: { sandbox: { mode: "all" }, heartbeat: { every: "1h" } },
          list: [],
        },
      },
      desiredAgent: { id: "worker" },
    });
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "agent.sandbox.mode",
          classification: "escalation",
          requiresDistinctConsent: true,
        }),
        expect.objectContaining({
          path: "agent.heartbeat.every",
          classification: "escalation",
          requiresDistinctConsent: true,
        }),
      ]),
    );
  });

  it("does not derive redacted capability digests from private details or payloads", () => {
    const firstMcp = mcpCapabilityChange({
      id: "search",
      action: "change",
      desired: { url: "https://first.example", auth: { scheme: "first" } },
    });
    const secondMcp = mcpCapabilityChange({
      id: "search",
      action: "change",
      desired: { url: "https://second.example", auth: { scheme: "second" } },
    });
    expect(firstMcp?.desired).toEqual(secondMcp?.desired);

    const firstCron = cronCapabilityChange({
      id: "report",
      action: "change",
      desired: { schedule: { cron: "0 9 * * *" }, session: "isolated", message: "first" },
    });
    const secondCron = cronCapabilityChange({
      id: "report",
      action: "change",
      desired: { schedule: { cron: "0 9 * * *" }, session: "isolated", message: "second" },
    });
    expect(firstCron?.desired).toEqual(secondCron?.desired);
  });
});
