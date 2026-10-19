import { describe, expect, it } from "vitest";
import { AgentsSchema } from "./zod-schema.agents.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("agent roster ownership", () => {
  it("rejects an empty roster after load-time migration", () => {
    expect(AgentsSchema.safeParse({ entries: {} }).success).toBe(false);
  });

  it("rejects a markerless multi-agent roster without explicit ownership", () => {
    const result = AgentsSchema.safeParse({ entries: { alpha: {}, beta: {} } });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('agents.ownership="explicit"');
      expect(result.error.issues[0]?.message).toContain("run openclaw doctor");
    }
  });

  it("rejects multiple legacy default markers", () => {
    expect(
      AgentsSchema.safeParse({
        entries: { alpha: { default: true }, beta: { default: true } },
      }).success,
    ).toBe(false);
  });

  it("rejects entry keys that resolve to the same agent id", () => {
    const result = AgentsSchema.safeParse({
      ownership: "explicit",
      entries: { Ops: {}, ops: {} },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        path: ["entries", "ops"],
        message:
          'agents.entries keys "Ops" and "ops" resolve to the same agent id "ops"; rename one key so each agent has a unique id',
      });
    }
  });

  it("rejects a legacy marker with explicit ownership", () => {
    expect(
      AgentsSchema.safeParse({
        ownership: "explicit",
        entries: { alpha: { default: true }, beta: {} },
      }).success,
    ).toBe(false);
  });
});

describe("explicit ambient agent targets", () => {
  it("rejects an unknown explicit target", () => {
    const result = OpenClawSchema.safeParse({
      agents: { defaults: { heartbeat: { agentId: "missing" } }, entries: { main: {} } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("Unknown agent id");
    }
  });

  it("accepts configured heartbeat, system-agent, compatibility, and Talk targets", () => {
    expect(
      OpenClawSchema.safeParse({
        agents: {
          defaults: {
            heartbeat: { agentId: "ops" },
            systemAgent: { agentId: "ops" },
            authInheritance: { agentId: "ops" },
            sessionStore: { agentId: "ops" },
          },
          entries: { ops: {} },
        },
        talk: { agentId: "ops" },
      }).success,
    ).toBe(true);
  });
});

describe("agent GitHub sandbox identity", () => {
  const profileId = "ghp_0123456789abcdef0123456789abcdef";

  it("accepts an explicit sandbox identity opt-in for one agent", () => {
    const github = { profileId, allowInSandbox: true };
    const result = AgentsSchema.safeParse({ entries: { release: { tools: { github } } } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data?.entries?.release?.tools?.github).toEqual(github);
    }
  });

  it("rejects a non-boolean sandbox identity opt-in", () => {
    const result = AgentsSchema.safeParse({
      entries: { release: { tools: { github: { profileId, allowInSandbox: "true" } } } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          path: ["entries", "release", "tools", "github", "allowInSandbox"],
        }),
      ]);
    }
  });

  it("rejects a global sandbox identity opt-in", () => {
    const result = OpenClawSchema.safeParse({
      tools: { github: { profileId, allowInSandbox: true } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({ path: ["tools", "github"], code: "unrecognized_keys" }),
      ]);
    }
  });
});
