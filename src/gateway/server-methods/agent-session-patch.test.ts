import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transitionMainSessionRecovery } from "../../agents/main-session-recovery/main-session-recovery-state.js";
import {
  mergeSessionEntry,
  resolveSessionResetPolicy,
  type InternalSessionEntry as SessionEntry,
} from "../../config/sessions.js";
import * as transcriptReader from "../../config/sessions/session-transcript-anchor-read.js";
import { buildAgentSessionPatch, type AgentSessionPatchBuild } from "./agent-session-patch.js";

beforeEach(() => {
  const read = transcriptReader.readSessionTranscriptAnchorsAsync;
  vi.spyOn(transcriptReader, "readSessionTranscriptAnchorsAsync").mockImplementation((...args) =>
    args[1].includeMetadata
      ? Promise.resolve({
          anchors: [],
          metadata: { present: true, observedAt: null, updatedAt: null },
        })
      : read(...args),
  );
});
afterEach(() => vi.restoreAllMocks());

async function buildPatch(
  touchInteraction: boolean,
  opts?: { requestLabel?: string; label?: string },
) {
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
  return (
    await buildAgentSessionPatch({
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
    })
  ).patch;
}

async function buildCreationPatch(opts: {
  canonicalSessionKey?: string;
  explicitSessionKey?: string;
  freshEntry?: SessionEntry;
  isSystemGatewayRun?: boolean;
  visibleRequest?: boolean;
}): Promise<AgentSessionPatchBuild> {
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
  });
}

describe("agent session patch", () => {
  it("clears agent status at the next human interaction boundary", async () => {
    const patch = await buildPatch(true);
    expect(Object.hasOwn(patch, "agentStatus")).toBe(true);
    expect(patch.agentStatus).toBeUndefined();
    expect(Object.hasOwn(patch, "lifecycleRunId")).toBe(true);
    expect(patch.lifecycleRunId).toBeUndefined();
    expect(patch.lastRunId).toBeUndefined();
  });

  it("does not clear agent status for lifecycle-only patches", async () => {
    expect(Object.hasOwn(await buildPatch(false), "agentStatus")).toBe(false);
  });

  it("preserves a recovery reservation while reusing a session with a failed outcome", async () => {
    const entry: SessionEntry = {
      sessionId: "recovering-session",
      updatedAt: 1_000,
      status: "failed",
      abortedLastRun: true,
      restartRecoveryDeliveryRunId: "recovery-run",
      mainRestartRecovery: {
        cycleId: "recovery-cycle",
        revision: 2,
        chargedAttempts: 1,
        reservation: { runId: "recovery-run", lifecycleGeneration: "generation-1", attempt: 1 },
      },
    };
    const { patch } = await buildCreationPatch({ freshEntry: entry, isSystemGatewayRun: true });
    const merged = mergeSessionEntry(entry, patch);

    expect(
      transitionMainSessionRecovery(merged, {
        kind: "validate_recovery",
        lifecycleGeneration: "generation-1",
        runId: "recovery-run",
        sessionId: entry.sessionId,
      }),
    ).toEqual({ kind: "recovery_validated" });
    expect(merged).toMatchObject({
      status: "failed",
      abortedLastRun: true,
      mainRestartRecovery: entry.mainRestartRecovery,
    });
  });

  // Public agent RPC labels retain their run-start contract; native spawn labels are creation-owned.
  it("persists the request label at run start", async () => {
    expect((await buildPatch(false, { requestLabel: "Fix flaky auth test" })).label).toBe(
      "Fix flaky auth test",
    );
  });

  it("keeps the existing label when the request has none", async () => {
    expect((await buildPatch(false, { label: "Existing" })).label).toBe("Existing");
  });

  it("names a new session from an explicit agent session key", async () => {
    const result = await buildCreationPatch({
      canonicalSessionKey: "agent:main:incident-42 ",
      explicitSessionKey: "agent:main:incident-42",
    });

    expect(result.patch.displayName).toBe("incident-42");
  });

  it("does not name an existing session", async () => {
    const entry: SessionEntry = { sessionId: "existing", updatedAt: 1_000 };
    const result = await buildCreationPatch({
      explicitSessionKey: "agent:main:incident-42",
      freshEntry: entry,
    });

    expect(result.patch).not.toHaveProperty("displayName");
  });

  it("does not replace an existing display name", async () => {
    const namedEntry = { displayName: "Existing display name" };
    const entry: SessionEntry = { sessionId: "existing", updatedAt: 1_000, ...namedEntry };
    const result = await buildCreationPatch({
      explicitSessionKey: "agent:main:incident-42",
      freshEntry: entry,
    });

    expect(mergeSessionEntry(entry, result.patch)).toMatchObject(namedEntry);
  });

  it("does not name a defaulted main session", async () => {
    expect(
      (await buildCreationPatch({ canonicalSessionKey: "agent:main:main" })).patch,
    ).not.toHaveProperty("displayName");
  });

  it("does not name an invisible run", async () => {
    const canonicalSessionKey = "agent:main:internal:probe";
    const result = await buildCreationPatch({
      canonicalSessionKey,
      explicitSessionKey: canonicalSessionKey,
      visibleRequest: false,
    });

    expect(result.patch).not.toHaveProperty("displayName");
  });

  it.each([
    ["subagent", "agent:main:subagent:worker-1"],
    ["ACP", "agent:main:acp:thread-1"],
  ] as const)("does not name a %s session", async (_kind, canonicalSessionKey) => {
    const result = await buildCreationPatch({
      canonicalSessionKey,
      explicitSessionKey: canonicalSessionKey,
    });

    expect(result.patch).not.toHaveProperty("displayName");
  });
});
