import { expect, it } from "vitest";
import {
  formatLegacyGatewayExecAdvisory,
  formatScheduledToolPolicyAdvisory,
} from "./repair-plan.js";
import { normalizeStoredCronJobs } from "./store-migration.js";

const sessionKey = "agent:main:discord:group:ops";
const directSessionKey = "agent:main:discord:work:direct:user-1";
const creator = { agentId: "main", sessionKey, accountId: "work" };
const policy = { version: 1, mode: "account", ownerSessionKey: sessionKey, ownerAccountId: "work" };
const shellPrompt = "Command to run:\n- command: python3 scripts/check_mail.py";
const aliasTools = ["read", "gateway_exec"];

function advisory(result: ReturnType<typeof normalizeStoredCronJobs>) {
  return formatScheduledToolPolicyAdvisory({
    legacyJobs: result.legacyScheduledToolPolicyJobs,
    invalidJobs: result.invalidScheduledToolPolicyJobs,
  });
}

function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "legacy",
    name: "Legacy",
    schedule: { kind: "every", everyMs: 60_000 },
    owner: { ...creator },
    payload: { kind: "agentTurn", message: "run", toolsAllow: ["write"] },
    ...overrides,
  };
}

it.each([
  {
    label: "agent mismatch",
    owner: { ...creator, agentId: "other", sessionKey: directSessionKey },
  },
  {
    label: "encoded account mismatch",
    owner: { ...creator, sessionKey: directSessionKey, accountId: "personal" },
  },
])("does not guess authority for $label", ({ owner }) => {
  const raw = job({ owner });
  const result = normalizeStoredCronJobs([raw]);
  expect(result.legacyScheduledToolPolicyJobs).toEqual(["Legacy"]);
  expect(raw.scheduledToolPolicy).toBeUndefined();
});

it("recovers a capless creator account without changing execution permissions", () => {
  const raw = job({
    owner: { agentId: "main", sessionKey: directSessionKey },
    payload: { kind: "agentTurn", message: "run" },
  });
  const result = normalizeStoredCronJobs([raw]);
  expect(raw.owner).toEqual({ ...creator, sessionKey: directSessionKey });
  expect(raw.payload).toEqual({ kind: "agentTurn", message: "run" });
  expect(raw.scheduledToolPolicy).toBeUndefined();
  expect(result.issues).toMatchObject({ reconciledOwnerAccount: 1 });
  expect(normalizeStoredCronJobs([raw]).issues).not.toHaveProperty("reconciledOwnerAccount");
});

it.each([
  ["malformed", { version: 2, mode: "trusted" }, shellPrompt, ["Legacy"], ["Legacy"]],
  ["owner-inconsistent", { ...policy, ownerAccountId: "personal" }, "run", ["Legacy"], []],
  ["trusted", { version: 1, mode: "trusted" }, "run", [], []],
] as const)(
  "preserves alias permissions with %s provenance",
  (_label, scheduledToolPolicy, message, invalid, commands) => {
    const raw = job({
      name: " Legacy ",
      payload: { kind: "agentTurn", message, toolsAllow: [...aliasTools] },
      scheduledToolPolicy,
    });
    const result = normalizeStoredCronJobs([raw]);
    expect(result).toMatchObject({
      invalidScheduledToolPolicyJobs: invalid,
      legacyGatewayExecJobs: ["Legacy"],
      unresolvedAgentTurnCommandPromptJobs: commands,
    });
    expect(raw.name).toBe("Legacy");
    expect(raw.payload).toEqual({ kind: "agentTurn", message, toolsAllow: aliasTools });
    expect(formatLegacyGatewayExecAdvisory(result.legacyGatewayExecJobs)).toContain(
      "will not convert this alias",
    );
  },
);

it("does not require tool authority for command payloads without a trigger", () => {
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

  expect(result).toMatchObject({
    invalidScheduledToolPolicyJobs: [],
    legacyScheduledToolPolicyJobs: ["Agent without authority", "Trigger without authority"],
  });
  expect(command.scheduledToolPolicy).toEqual(policy);
  expect(command.payload).toEqual({ kind: "command", argv: ["sh", "-lc", "true"] });
  expect(command.toolsAllowProvenance).toBeUndefined();
  expect(advisory(result)).not.toContain("Command");
});

it("reports auto-recoverable and ambiguous jobs through the doctor result", () => {
  const ambiguous = job({
    id: "ambiguous",
    name: "Ambiguous",
    owner: { agentId: "main", sessionKey },
  });
  const result = normalizeStoredCronJobs([job(), ambiguous]);

  expect(result.issues.migratedScheduledToolPolicy).toBe(1);
  expect(result.legacyScheduledToolPolicyJobs).toEqual(["Ambiguous"]);
  expect(advisory(result)).toContain("openclaw automations edit <id> --tools");
});
