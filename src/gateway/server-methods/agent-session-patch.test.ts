import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { transitionMainSessionRecovery } from "../../agents/main-session-recovery/main-session-recovery-state.js";
import {
  mergeSessionEntry,
  resolveSessionResetPolicy,
  type InternalSessionEntry as SessionEntry,
} from "../../config/sessions.js";
import * as transcriptReader from "../../config/sessions/session-transcript-anchor-read.js";
import { buildAgentSessionPatch } from "./agent-session-patch.js";

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

type PatchInput = Partial<Parameters<typeof buildAgentSessionPatch>[0]>;
function buildCreationPatch(opts: PatchInput) {
  return buildAgentSessionPatch({
    freshEntry: opts.freshEntry,
    initialEntry: opts.freshEntry,
    cfg: {},
    sessionAgentId: "main",
    canonicalSessionKey: "agent:main:incident-42",
    storePath: "/tmp/openclaw-explicit-session-name-test.json",
    normalizedSpawned: {},
    requestDeliveryHint: undefined,
    expectedExistingSessionId: opts.freshEntry?.sessionId,
    hasRestoredCronContinuation: false,
    resetPolicy: resolveSessionResetPolicy({ resetType: "direct" }),
    now: 1_000,
    isSystemGatewayRun: false,
    visibleRequest: true,
    fallbackSessionId: "fallback",
    touchInteraction: false,
    ...opts,
  });
}

const failedEntry: SessionEntry = {
  sessionId: "session",
  updatedAt: 1_000,
  status: "failed",
  lifecycleRunId: "completed-run",
  lastRunId: "completed-run",
  agentStatus: { note: "Need a password", attention: "key", expiresAt: 61_000 },
};

it("retains internal session delivery across channel-less agent turns", async () => {
  const freshEntry: SessionEntry = { ...failedEntry, delivery: { kind: "internal" } };
  const { patch } = await buildCreationPatch({ freshEntry });
  expect(patch.delivery).toEqual({ kind: "internal" });

  const routed = await buildCreationPatch({
    freshEntry,
    requestDeliveryHint: { channel: "telegram", to: "123" },
  });
  expect(routed.patch.delivery).toMatchObject({
    kind: "external",
    context: { channel: "telegram", to: "123" },
  });
  expect((await buildCreationPatch({})).patch.delivery).toEqual({ kind: "none" });
});

it("clears agent status at the next human interaction boundary", async () => {
  const { patch } = await buildCreationPatch({
    freshEntry: failedEntry,
    touchInteraction: true,
    isSystemGatewayRun: true,
    canonicalSessionKey: "agent:main:main",
  });
  expect(patch).toMatchObject({ agentStatus: undefined, lifecycleRunId: undefined });
  expect(patch.lastRunId).toBeUndefined();
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

it.each([
  { label: undefined, requestLabel: "Fix flaky auth test", expected: "Fix flaky auth test" },
  { label: "Existing", requestLabel: undefined, expected: "Existing" },
])("preserves the run-start label $expected", async ({ label, requestLabel, expected }) => {
  const { patch } = await buildCreationPatch({
    freshEntry: { ...failedEntry, label },
    requestLabel,
    isSystemGatewayRun: true,
    canonicalSessionKey: "agent:main:main",
  });
  expect(patch.label).toBe(expected);
  if (label) {
    expect(Object.hasOwn(patch, "agentStatus")).toBe(false);
  }
});

it.each([
  {
    name: "existing session",
    key: "agent:main:incident-42",
    displayName: "Existing",
    entry: { sessionId: "existing", updatedAt: 1_000, displayName: "Existing" },
  },
  { name: "explicit key", key: "agent:main:incident-42", displayName: "incident-42" },
  { name: "defaulted main", key: "agent:main:main", defaulted: true },
  { name: "invisible run", key: "agent:main:internal:probe", invisible: true },
  { name: "subagent", key: "agent:main:subagent:worker-1" },
  { name: "ACP", key: "agent:main:acp:thread-1" },
])(
  "derives the display name for $name",
  async ({ key, displayName, defaulted, invisible, entry }) => {
    const { patch } = await buildCreationPatch({
      canonicalSessionKey: displayName && !entry ? `${key} ` : key,
      explicitSessionKey: defaulted ? undefined : key,
      visibleRequest: !invisible,
      freshEntry: entry,
    });
    expect(mergeSessionEntry(entry, patch).displayName).toBe(displayName);
    if (!displayName) {
      expect(patch).not.toHaveProperty("displayName");
    }
  },
);
