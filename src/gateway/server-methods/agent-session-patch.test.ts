import { describe, expect, it } from "vitest";
import {
  mergeSessionEntry,
  resolveSessionResetPolicy,
  type InternalSessionEntry as SessionEntry,
} from "../../config/sessions.js";
import { buildAgentSessionPatch, type AgentSessionPatchBuild } from "./agent-session-patch.js";

function buildPatch(touchInteraction: boolean, opts?: { requestLabel?: string; label?: string }) {
  const now = 1_000;
  const entry: SessionEntry = {
    sessionId: "session",
    updatedAt: now,
    lifecycleRunId: "completed-run",
    lastRunId: "completed-run",
    status: "failed",
    agentStatus: { note: "Need a password", attention: "key", expiresAt: now + 60_000 },
    ...(opts?.label ? { label: opts.label } : {}),
  };
  return buildAgentSessionPatch({
    freshEntry: entry,
    initialEntry: entry,
    ...(opts?.requestLabel ? { requestLabel: opts.requestLabel } : {}),
    cfg: {},
    sessionAgentId: "main",
    canonicalSessionKey: "agent:main:main",
    storePath: "/tmp/openclaw-agent-status-test.json",
    normalizedSpawned: {},
    requestDeliveryHint: undefined,
    expectedExistingSessionId: entry.sessionId,
    hasRestoredCronContinuation: false,
    resetPolicy: resolveSessionResetPolicy({ resetType: "direct" }),
    now,
    isSystemGatewayRun: true,
    visibleRequest: true,
    fallbackSessionId: "fallback",
    touchInteraction,
    failedSessionTranscriptMissing: () => false,
  }).patch;
}

function buildCreationPatch(opts: {
  canonicalSessionKey?: string;
  explicitSessionKey?: string;
  freshEntry?: SessionEntry;
  isSystemGatewayRun?: boolean;
  visibleRequest?: boolean;
}): AgentSessionPatchBuild {
  const now = 1_000;
  return buildAgentSessionPatch({
    freshEntry: opts.freshEntry,
    initialEntry: opts.freshEntry,
    cfg: {},
    sessionAgentId: "main",
    canonicalSessionKey: opts.canonicalSessionKey ?? "agent:main:incident-42",
    storePath: "/tmp/openclaw-explicit-session-name-test.json",
    normalizedSpawned: {},
    requestDeliveryHint: undefined,
    ...(opts.explicitSessionKey ? { explicitSessionKey: opts.explicitSessionKey } : {}),
    ...(opts.freshEntry?.sessionId ? { expectedExistingSessionId: opts.freshEntry.sessionId } : {}),
    hasRestoredCronContinuation: false,
    resetPolicy: resolveSessionResetPolicy({ resetType: "direct" }),
    now,
    isSystemGatewayRun: opts.isSystemGatewayRun ?? false,
    visibleRequest: opts.visibleRequest ?? true,
    fallbackSessionId: "fallback",
    touchInteraction: false,
    failedSessionTranscriptMissing: () => false,
  });
}

describe("agent session patch", () => {
  it("clears agent status at the next human interaction boundary", () => {
    const patch = buildPatch(true);
    expect(Object.hasOwn(patch, "agentStatus")).toBe(true);
    expect(patch.agentStatus).toBeUndefined();
    expect(Object.hasOwn(patch, "lifecycleRunId")).toBe(true);
    expect(patch.lifecycleRunId).toBeUndefined();
    expect(patch.lastRunId).toBeUndefined();
  });

  it("does not clear agent status for lifecycle-only patches", () => {
    expect(Object.hasOwn(buildPatch(false), "agentStatus")).toBe(false);
  });

  // Public agent RPC labels retain their run-start contract; native spawn labels are creation-owned.
  it("persists the request label at run start", () => {
    expect(buildPatch(false, { requestLabel: "Fix flaky auth test" }).label).toBe(
      "Fix flaky auth test",
    );
  });

  it("keeps the existing label when the request has none", () => {
    expect(buildPatch(false, { label: "Existing" }).label).toBe("Existing");
  });

  it("names a new session from an explicit agent session key", () => {
    const result = buildCreationPatch({
      canonicalSessionKey: "agent:main:incident-42 ",
      explicitSessionKey: "agent:main:incident-42",
    });

    expect(result.patch.displayName).toBe("incident-42");
  });

  it("does not name an existing session", () => {
    const entry: SessionEntry = { sessionId: "existing", updatedAt: 1_000 };
    const result = buildCreationPatch({
      explicitSessionKey: "agent:main:incident-42",
      freshEntry: entry,
    });

    expect(result.patch).not.toHaveProperty("displayName");
  });

  it("does not replace an existing display name", () => {
    const namedEntry = { displayName: "Existing display name" };
    const entry: SessionEntry = { sessionId: "existing", updatedAt: 1_000, ...namedEntry };
    const result = buildCreationPatch({
      explicitSessionKey: "agent:main:incident-42",
      freshEntry: entry,
    });

    expect(mergeSessionEntry(entry, result.patch)).toMatchObject(namedEntry);
  });

  it("does not name a defaulted main session", () => {
    expect(buildCreationPatch({ canonicalSessionKey: "agent:main:main" }).patch).not.toHaveProperty(
      "displayName",
    );
  });

  it("does not name an invisible run", () => {
    const canonicalSessionKey = "agent:main:internal:probe";
    const result = buildCreationPatch({
      canonicalSessionKey,
      explicitSessionKey: canonicalSessionKey,
      visibleRequest: false,
    });

    expect(result.patch).not.toHaveProperty("displayName");
  });

  it.each([
    ["subagent", "agent:main:subagent:worker-1"],
    ["ACP", "agent:main:acp:thread-1"],
  ] as const)("does not name a %s session", (_kind, canonicalSessionKey) => {
    const result = buildCreationPatch({
      canonicalSessionKey,
      explicitSessionKey: canonicalSessionKey,
    });

    expect(result.patch).not.toHaveProperty("displayName");
  });
});
