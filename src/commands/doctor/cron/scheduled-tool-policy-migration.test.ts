import { describe, expect, it } from "vitest";
import {
  formatLegacyGatewayExecAdvisory,
  formatScheduledToolPolicyAdvisory,
} from "./repair-plan.js";
import { normalizeStoredCronJobs } from "./store-migration.js";

function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "legacy",
    name: "Legacy",
    enabled: true,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    owner: {
      agentId: "main",
      sessionKey: "agent:main:discord:group:ops",
      accountId: "work",
    },
    payload: { kind: "agentTurn", message: "run", toolsAllow: ["write"] },
    ...overrides,
  };
}

describe("migrateScheduledToolPolicy", () => {
  it.each([
    {
      label: "agent mismatch",
      owner: {
        agentId: "other",
        sessionKey: "agent:main:discord:work:direct:user-1",
        accountId: "work",
      },
    },
    {
      label: "encoded account mismatch",
      owner: {
        agentId: "main",
        sessionKey: "agent:main:discord:work:direct:user-1",
        accountId: "personal",
      },
    },
  ])("does not guess authority for $label", ({ owner }) => {
    const raw = job({ owner });
    const result = normalizeStoredCronJobs([raw]);
    expect(result.legacyScheduledToolPolicyJobs).toEqual(["Legacy"]);
    expect(raw.scheduledToolPolicy).toBeUndefined();
  });

  it("recovers a capless creator account without changing execution permissions", () => {
    const raw = job({
      owner: { agentId: "main", sessionKey: "agent:main:discord:work:direct:user-1" },
      payload: { kind: "agentTurn", message: "run" },
    });
    const result = normalizeStoredCronJobs([raw]);
    expect(raw.owner).toEqual({
      agentId: "main",
      sessionKey: "agent:main:discord:work:direct:user-1",
      accountId: "work",
    });
    expect(raw.payload).toEqual({ kind: "agentTurn", message: "run" });
    expect(raw.scheduledToolPolicy).toBeUndefined();
    expect(result.issues).toMatchObject({ reconciledOwnerAccount: 1 });
    expect(normalizeStoredCronJobs([raw]).issues).not.toHaveProperty("reconciledOwnerAccount");
  });

  it("rejects malformed and owner-inconsistent provenance", () => {
    const malformed = job({ scheduledToolPolicy: { version: 2, mode: "trusted" } });
    expect(normalizeStoredCronJobs([malformed]).invalidScheduledToolPolicyJobs).toEqual(["Legacy"]);

    const inconsistent = job({
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:discord:group:ops",
        ownerAccountId: "personal",
      },
    });
    expect(normalizeStoredCronJobs([inconsistent]).invalidScheduledToolPolicyJobs).toEqual([
      "Legacy",
    ]);
  });

  it("does not require tool authority for command payloads without a trigger", () => {
    const policy = {
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:discord:group:ops",
      ownerAccountId: "work",
    };
    const payload = { kind: "command", argv: ["sh", "-lc", "true"] };
    const command = job({
      name: "Command",
      payload,
      scheduledToolPolicy: structuredClone(policy),
    });
    const agent = job({ name: "Agent without authority", owner: undefined });
    const triggered = job({
      name: "Trigger without authority",
      owner: undefined,
      payload: { ...payload, toolsAllow: ["read"] },
      trigger: { script: "json({ fire: true })" },
    });

    const result = normalizeStoredCronJobs([command, agent, triggered]);

    expect(result.invalidScheduledToolPolicyJobs).toEqual([]);
    expect(result.legacyScheduledToolPolicyJobs).toEqual([
      "Agent without authority",
      "Trigger without authority",
    ]);
    expect(command.scheduledToolPolicy).toEqual(policy);
    expect(command.payload).toEqual({ kind: "command", argv: ["sh", "-lc", "true"] });
    expect(command.toolsAllowProvenance).toBeUndefined();
    expect(
      formatScheduledToolPolicyAdvisory({
        legacyJobs: result.legacyScheduledToolPolicyJobs,
        invalidJobs: result.invalidScheduledToolPolicyJobs,
      }),
    ).not.toContain("Command");
  });

  it("reports auto-recoverable and ambiguous jobs through the doctor result", () => {
    const recoverable = job();
    const ambiguous = job({
      id: "ambiguous",
      name: "Ambiguous",
      owner: { agentId: "main", sessionKey: "agent:main:discord:group:ops" },
    });
    const result = normalizeStoredCronJobs([recoverable, ambiguous]);

    expect(result.issues.migratedScheduledToolPolicy).toBe(1);
    expect(result.legacyScheduledToolPolicyJobs).toEqual(["Ambiguous"]);
    expect(
      formatScheduledToolPolicyAdvisory({
        legacyJobs: result.legacyScheduledToolPolicyJobs,
        invalidJobs: result.invalidScheduledToolPolicyJobs,
      }),
    ).toContain("openclaw automations edit <id> --tools");
  });

  it("reports alias-only Gateway exec jobs without converting their authority", () => {
    const raw = job({
      payload: { kind: "agentTurn", message: "run", toolsAllow: ["read", "gateway_exec"] },
      scheduledToolPolicy: { version: 1, mode: "trusted" },
    });

    const result = normalizeStoredCronJobs([raw]);

    expect(result.legacyGatewayExecJobs).toEqual(["Legacy"]);
    expect((raw.payload as { toolsAllow: string[] }).toolsAllow).toEqual(["read", "gateway_exec"]);
    expect(formatLegacyGatewayExecAdvisory(result.legacyGatewayExecJobs)).toContain(
      "will not convert this alias",
    );
  });
});
