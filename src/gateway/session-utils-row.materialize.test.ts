import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { buildSubagentRunReadIndexFromRuns } from "../agents/subagents/registry/subagent-registry-queries.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { InternalSessionEntry, SessionEntry } from "../config/sessions.js";
import { ACTIVITY_SUMMARY_FORMAT_REVISION } from "../config/sessions/activity-summary.js";
import {
  appendTranscriptMessageSync,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { projectSessionActivitySummary } from "./session-activity-summary-state.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";
import {
  buildGatewaySessionRow,
  materializeSessionRow,
  presentSessionRow,
  readSessionRowInputs,
} from "./session-utils-row.js";
import type { GatewaySessionRow } from "./session-utils.types.js";
import {
  projectWorkerSessionPlacement,
  readWorkerPlacementIdentity,
} from "./worker-environments/placement-projector.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-store.js";

// Frozen from the unchanged builder at 7b47d7a65a17e7a49d943795a5b112ae4adcfe3c.
// SHA256 pins JSON.stringify wire bytes, including serialized property order.
// Re-pinned once for the additive `modelSelectionSource` field: every fixture below
// differs from the previous pin only by that key, with all other bytes unchanged.
const START = Date.UTC(2026, 8, 15);
const TIMES = [START + 29_999, START + 30_000, START + 7_200_001] as const;
const GOLDEN_HASHES: Record<string, readonly [string, string, string]> = {
  "ACP metadata owns the runtime": [
    "f0cb305556e762696466faab14cf85248bca15daedb5c193c43e948199c1951b",
    "f0cb305556e762696466faab14cf85248bca15daedb5c193c43e948199c1951b",
    "f0cb305556e762696466faab14cf85248bca15daedb5c193c43e948199c1951b",
  ],
  "activity current and active correlated placement": [
    "30d5b99945fdf5fed284ebea67a51f1f20a15072a64bcb8e1a4fad461c85a20d",
    "30d5b99945fdf5fed284ebea67a51f1f20a15072a64bcb8e1a4fad461c85a20d",
    "30d5b99945fdf5fed284ebea67a51f1f20a15072a64bcb8e1a4fad461c85a20d",
  ],
  "activity stale and uncorrelated placement": [
    "eac603302042d26a4b978b9aa709dbb71734b42d9d3d8b519054649066ffc84c",
    "eac603302042d26a4b978b9aa709dbb71734b42d9d3d8b519054649066ffc84c",
    "eac603302042d26a4b978b9aa709dbb71734b42d9d3d8b519054649066ffc84c",
  ],
  "child retention keeps canonical live recent and unknown links": [
    "8d970acdfaa51af1bb301ae7abb92a0185360ca5bbdcc071d619c9ff63038367",
    "8d970acdfaa51af1bb301ae7abb92a0185360ca5bbdcc071d619c9ff63038367",
    "6c4c217c6a124d7490c76de90710bf3db37a246d3f9435332c1d0fb3dd0c8748",
  ],
  "ended run uses persisted lifecycle timestamps": [
    "0c45ddebbf294f4a2e042fa278af6347e414b4009605d5d47512bead0984347c",
    "0c45ddebbf294f4a2e042fa278af6347e414b4009605d5d47512bead0984347c",
    "0c45ddebbf294f4a2e042fa278af6347e414b4009605d5d47512bead0984347c",
  ],
  "expired status and incognito draft": [
    "adbfa3eb2b860b14a10d033c98da84ba8ad6789414ab77136be4f4c500be0efa",
    "adbfa3eb2b860b14a10d033c98da84ba8ad6789414ab77136be4f4c500be0efa",
    "adbfa3eb2b860b14a10d033c98da84ba8ad6789414ab77136be4f4c500be0efa",
  ],
  "goal below budget retains committed timestamps": [
    "cf0dadfd8a593eb46b07c96e39d83ed2da19d69ce861c23420f24205d16ee5c5",
    "cf0dadfd8a593eb46b07c96e39d83ed2da19d69ce861c23420f24205d16ee5c5",
    "cf0dadfd8a593eb46b07c96e39d83ed2da19d69ce861c23420f24205d16ee5c5",
  ],
  "goal budget becomes limited at presentation time": [
    "cea553b58147b59b36019303d4f33476cfc7aeb721b56edc38c1129cf131ef8e",
    "aefa13e71591f006e55d38773e59a0bbabb419c8fb1b280a08cf54423c315c82",
    "7b2fdf0c168dd36be0b6f2a504f6c2d46fe0b08853fa89ef679171c21bd32ad3",
  ],
  "live status and persisted running lifecycle": [
    "af4f3a92bc8e98472d14f128ce19f26689e4d62406e623686a7569bb55c40714",
    "f2c6fc464d079af31d5a92cfb6b006e74349b9de96b6ccf1ebf77968b4a50f31",
    "f2c6fc464d079af31d5a92cfb6b006e74349b9de96b6ccf1ebf77968b4a50f31",
  ],
  "live subagent accumulated runtime and inherited model": [
    "9bdc716100c855c0a4040df1a34bb8902f07f0995ddc19d0b32340ce2315416a",
    "9bdc716100c855c0a4040df1a34bb8902f07f0995ddc19d0b32340ce2315416a",
    "9bdc716100c855c0a4040df1a34bb8902f07f0995ddc19d0b32340ce2315416a",
  ],
  "missing entry": [
    "7d513f039987cdd788f15d637e059bb5b10f62cd3487998018c5d81da76131e6",
    "7d513f039987cdd788f15d637e059bb5b10f62cd3487998018c5d81da76131e6",
    "7d513f039987cdd788f15d637e059bb5b10f62cd3487998018c5d81da76131e6",
  ],
  "observer digest equal than run start": [
    "771939d8d0aeb4d17b445568e744de878c5b651a6167cd7bb324de2c26a996ce",
    "771939d8d0aeb4d17b445568e744de878c5b651a6167cd7bb324de2c26a996ce",
    "771939d8d0aeb4d17b445568e744de878c5b651a6167cd7bb324de2c26a996ce",
  ],
  "observer digest newer than run start": [
    "7115a9f495e64b9e27d7547c50793b2b997777fd643ada2cc2675df317f0609b",
    "7115a9f495e64b9e27d7547c50793b2b997777fd643ada2cc2675df317f0609b",
    "7115a9f495e64b9e27d7547c50793b2b997777fd643ada2cc2675df317f0609b",
  ],
  "observer digest older than run start": [
    "554eb4741afbed4586e01e012594b9158c4918bf4ef78b78809dba9f84ebe9dc",
    "554eb4741afbed4586e01e012594b9158c4918bf4ef78b78809dba9f84ebe9dc",
    "554eb4741afbed4586e01e012594b9158c4918bf4ef78b78809dba9f84ebe9dc",
  ],
  "retention changes control owner and transcript fallback cost": [
    "789234207545c13ee8c952eefe9ee2e08afcc0492984724e801bac99ee3e4495",
    "789234207545c13ee8c952eefe9ee2e08afcc0492984724e801bac99ee3e4495",
    "7d5b353a033be94d8ee0c96152efcd92588b243e5e12e4452a41a1f1a97ab4b3",
  ],
  "single-row snapshot without an explicit swarm context": [
    "4c8bd3527f5c41082b061d2d1a4d9c046a2c9f4cc7a9625f454d265c64494f1a",
    "4c8bd3527f5c41082b061d2d1a4d9c046a2c9f4cc7a9625f454d265c64494f1a",
    "4c8bd3527f5c41082b061d2d1a4d9c046a2c9f4cc7a9625f454d265c64494f1a",
  ],
  "swarm summary retains collector completion and children": [
    "790cbb64cfeb7f8e30d13e8ccd6304926a01265494e5c5be4d452f8deb166ec4",
    "790cbb64cfeb7f8e30d13e8ccd6304926a01265494e5c5be4d452f8deb166ec4",
    "790cbb64cfeb7f8e30d13e8ccd6304926a01265494e5c5be4d452f8deb166ec4",
  ],
};

const PARENT = "agent:main:dashboard:parent";
const LIVE = "agent:main:subagent:live";
const RETAINED = "agent:main:subagent:retained";
const LIVE_RUN = "materialize-golden-live";
const BASE_ENTRY = { sessionId: "golden-session", updatedAt: START, createdAt: START - 1_000 };
const GOAL = {
  schemaVersion: 1,
  id: "golden-goal",
  objective: "Finish the synthetic fixture",
  status: "active",
  createdAt: START - 1_000,
  updatedAt: START,
  tokenStart: 20,
  tokenStartFresh: true,
  tokensUsed: 0,
  tokenBudget: 100,
  continuationTurns: 2,
} satisfies NonNullable<SessionEntry["goal"]>;

type RowFixture = {
  name: string;
  key: string;
  entry?: InternalSessionEntry;
  store?: Record<string, SessionEntry>;
  runs?: SubagentRunRecord[];
  transcript?: boolean;
  omitRowContext?: boolean;
  decoration?: "current" | "stale";
};

function config(): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "main", default: true, identity: { name: "Fixture agent" } }],
      defaults: {
        model: { primary: "row-fixture/primary" },
        thinkingDefault: "off",
        models: { "row-fixture/primary": { agentRuntime: { id: "pi" } } },
      },
    },
    models: {
      providers: {
        "row-fixture": {
          baseUrl: "https://fixture.invalid/v1",
          api: "openai-completions",
          models: ["primary", "older", "newer"].map((id, index) => ({
            id,
            name: id,
            reasoning: false,
            input: ["text"],
            cost: { input: index + 1, output: (index + 1) * 2, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 8_192,
          })),
        },
      },
    },
  };
}

function fixtures(): RowFixture[] {
  const ended = "agent:main:subagent:ended";
  const unknown = "agent:main:subagent:unknown";
  const parentEntry: SessionEntry = {
    ...BASE_ENTRY,
    sessionId: "parent-session",
    providerOverride: "row-fixture",
    modelOverride: "newer",
    modelOverrideSource: "user",
  };
  const childStore: Record<string, SessionEntry> = {
    [PARENT]: parentEntry,
    [LIVE]: {
      ...BASE_ENTRY,
      sessionId: "live-session",
      parentSessionKey: PARENT,
      status: "running",
    },
    [ended]: { ...BASE_ENTRY, parentSessionKey: PARENT, status: "done", endedAt: START },
    [unknown]: { ...BASE_ENTRY, parentSessionKey: PARENT },
    "agent:main:subagent:stale": {
      ...BASE_ENTRY,
      parentSessionKey: PARENT,
      updatedAt: START - 7_200_000,
    },
  };
  const liveRun = createSubagentRunRecord({
    runId: LIVE_RUN,
    childSessionKey: LIVE,
    requesterSessionKey: PARENT,
    createdAt: START - 2_000,
    startedAt: START,
    accumulatedRuntimeMs: 500,
    model: "row-fixture/older",
  });
  const retainedRuns = [
    createSubagentRunRecord({
      runId: "golden-older-unended",
      childSessionKey: RETAINED,
      requesterSessionKey: "agent:main:parent-a",
      createdAt: START,
      startedAt: START,
      model: "row-fixture/older",
    }),
    createSubagentRunRecord({
      runId: "golden-newer-ended",
      childSessionKey: RETAINED,
      requesterSessionKey: "agent:main:parent-b",
      createdAt: START + 10_000,
      startedAt: START + 10_000,
      endedAt: START + 20_000,
      model: "row-fixture/newer",
    }),
  ];
  const activityEntry: SessionEntry = {
    ...BASE_ENTRY,
    activitySummary: {
      version: 1,
      formatRevision: ACTIVITY_SUMMARY_FORMAT_REVISION,
      sessionId: BASE_ENTRY.sessionId,
      text: "Completed the fixture and checked its output.",
      updatedAt: START,
      generation: "golden-generation",
      maxSeq: 2,
      leafEntryId: "golden-leaf",
      coveredMessages: 2,
      totalMessages: 2,
      omittedContent: false,
    },
  };
  return [
    { name: "missing entry", key: "agent:main:dashboard:missing" },
    {
      name: "single-row snapshot without an explicit swarm context",
      key: "agent:main:dashboard:single",
      entry: BASE_ENTRY,
      omitRowContext: true,
    },
    {
      name: "live status and persisted running lifecycle",
      key: "agent:main:dashboard:running",
      entry: {
        ...BASE_ENTRY,
        status: "running",
        startedAt: START,
        agentStatus: { note: "Need a key", attention: "key", expiresAt: START + 30_000 },
      },
    },
    {
      name: "expired status and incognito draft",
      key: "agent:main:dashboard:incognito",
      entry: {
        ...BASE_ENTRY,
        visibility: "draft",
        incognito: true,
        agentStatus: { note: "Expired", expiresAt: START - 1 },
        pinnedAt: START,
        label: "Private fixture",
      },
    },
    {
      name: "goal budget becomes limited at presentation time",
      key: "agent:main:dashboard:budget",
      entry: {
        ...BASE_ENTRY,
        goal: GOAL,
        totalTokens: 150,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
    },
    {
      name: "goal below budget retains committed timestamps",
      key: "agent:main:dashboard:goal",
      entry: {
        ...BASE_ENTRY,
        goal: { ...GOAL, tokensUsed: 5 },
        totalTokens: 50,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
    },
    ...([-1, 0, 1] as const).map((offset): RowFixture => ({
      name: `observer digest ${offset < 0 ? "older" : offset === 0 ? "equal" : "newer"} than run start`,
      key: `agent:main:dashboard:observer-${offset}`,
      entry: {
        ...BASE_ENTRY,
        startedAt: START,
        observerDigest: {
          sessionKey: `agent:main:dashboard:observer-${offset}`,
          agentId: "main",
          runId: "observer-run",
          headline: "The fixture is ready",
          health: "wrapping-up",
          updatedAt: START + offset,
          revision: 3,
        },
      },
    })),
    {
      name: "live subagent accumulated runtime and inherited model",
      key: LIVE,
      entry: childStore[LIVE],
      store: childStore,
      runs: [liveRun],
    },
    {
      name: "ended run uses persisted lifecycle timestamps",
      key: ended,
      entry: {
        ...BASE_ENTRY,
        status: "failed",
        startedAt: START - 500,
        endedAt: START + 1_000,
        runtimeMs: 1_500,
        lastRunError: "Synthetic failure",
      },
      runs: [
        createSubagentRunRecord({
          runId: "golden-ended",
          childSessionKey: ended,
          requesterSessionKey: PARENT,
          createdAt: START - 1_000,
          startedAt: START,
          endedAt: START + 100,
        }),
      ],
    },
    {
      name: "child retention keeps canonical live recent and unknown links",
      key: PARENT,
      entry: parentEntry,
      store: childStore,
      runs: [liveRun],
    },
    {
      name: "swarm summary retains collector completion and children",
      key: PARENT,
      entry: parentEntry,
      runs: ["running", "queued", "done", "failed"].map((status, index) =>
        createSubagentRunRecord({
          runId: `golden-swarm-${status}`,
          childSessionKey: `agent:main:subagent:swarm-${status}`,
          requesterSessionKey: PARENT,
          requesterAgentId: "main",
          swarmRequesterSessionKey: PARENT,
          collect: true,
          groupId: "golden-group",
          createdAt: START + index,
          execution:
            status === "queued" ? { status: "queued" } : { status: "running", startedAt: START },
          ...(status === "done" || status === "failed"
            ? { collectorCompletion: { status: status === "done" ? "done" : "failed" } }
            : {}),
        }),
      ),
    },
    {
      name: "ACP metadata owns the runtime",
      key: "agent:main:acp:golden",
      entry: {
        ...BASE_ENTRY,
        acp: {
          backend: "acpx",
          agent: "fixture",
          runtimeSessionName: "golden-acp",
          mode: "persistent",
          state: "idle",
          lastActivityAt: START,
        },
      },
    },
    {
      name: "activity current and active correlated placement",
      key: "agent:main:dashboard:activity-current",
      entry: activityEntry,
      decoration: "current",
    },
    {
      name: "activity stale and uncorrelated placement",
      key: "agent:main:dashboard:activity-stale",
      entry: activityEntry,
      decoration: "stale",
    },
    {
      name: "retention changes control owner and transcript fallback cost",
      key: RETAINED,
      entry: { ...BASE_ENTRY, sessionId: "retained-session" },
      runs: retainedRuns,
      transcript: true,
    },
  ];
}

function decorate(row: GatewaySessionRow, fixture: RowFixture, cfg: OpenClawConfig) {
  if (!fixture.decoration) {
    return row;
  }
  const current = fixture.decoration === "current";
  const placement = {
    sessionId: BASE_ENTRY.sessionId,
    sessionKey: fixture.key,
    agentId: "main",
    executionMode: "worker-turn",
    state: "active",
    generation: 4,
    environmentId: "golden-environment",
    activeOwnerEpoch: 7,
    workerBundleHash: "a".repeat(64),
    workspaceBaseManifestRef: "golden-manifest",
    remoteWorkspaceDir: "/workspace",
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
    turnClaim: null,
    createdAtMs: START - 1_000,
    updatedAtMs: START,
    stateChangedAtMs: START,
  } satisfies WorkerSessionPlacementRecord;
  const identity = readWorkerPlacementIdentity(placement, {
    get: () => ({
      environmentId: "golden-environment",
      providerId: "fixture-worker",
      profileId: "fixture-profile",
      ownerEpoch: current ? 7 : 8,
      state: "requested",
      leaseId: null,
      sharedHost: null,
      createdAtMs: START,
      idleSinceAtMs: null,
      attachedSessionIds: [],
      desktopAvailable: false,
      desktopApps: [],
      tunnelStatus: "stopped",
    }),
    readMachineShape: () => ({ class: "medium", os: "linux", cpu: 4, memoryGb: 16 }),
  });
  const activitySummary = projectSessionActivitySummary({
    cfg,
    key: fixture.key,
    agentId: "main",
    entry: fixture.entry,
    enabled: true,
    watermark: { generation: "golden-generation", maxSeq: current ? 2 : 3 },
  });
  return Object.assign(row, {
    sharingRole: current ? "owner" : "viewer",
    activitySummary: activitySummary ? { ...activitySummary, canEnsure: current } : undefined,
    placement: projectWorkerSessionPlacement(placement, undefined, undefined, identity),
  });
}

afterEach(() => {
  clearAgentRunContext(LIVE_RUN);
  resetConfigRuntimeState();
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

test("stamps read snapshots without changing persisted session update time", async () => {
  await withStateDirEnv("openclaw-row-snapshot-clock-", async ({ stateDir }) => {
    const cfg = config();
    setRuntimeConfigSnapshot(cfg);
    setActivePluginRegistry(createEmptyPluginRegistry());
    const key = "agent:main:snapshot-clock";
    const entry = { sessionId: "snapshot-clock", updatedAt: 10 };
    const project = (now: number) =>
      buildGatewaySessionRow({
        cfg,
        agentId: "main",
        storePath: path.join(stateDir, "agents", "main", "sessions", "sessions.json"),
        store: { [key]: entry },
        key,
        entry,
        now,
        skipTranscriptUsageFallback: true,
      });
    const earlier = project(100);
    const later = project(200);
    expect(earlier).toMatchObject({ snapshotAt: 100, updatedAt: 10 });
    expect(later).toMatchObject({ snapshotAt: 200, updatedAt: 10 });
    expect(structuredClone(earlier).snapshotAt).toBe(100);
    expect(entry).toEqual({ sessionId: "snapshot-clock", updatedAt: 10 });
  });
});

test("preserves complete base rows across time and caller presentation fixtures", async () => {
  await withStateDirEnv("openclaw-row-materialize-golden-", async ({ stateDir }) => {
    const cfg = config();
    setRuntimeConfigSnapshot(cfg);
    setActivePluginRegistry(createEmptyPluginRegistry());
    registerAgentRunContext(LIVE_RUN, {
      agentId: "main",
      sessionKey: LIVE,
      sessionId: "live-session",
      activeModel: { provider: "row-fixture", model: "older" },
    });
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    for (const fixture of fixtures()) {
      if (fixture.transcript && fixture.entry) {
        const scope = {
          agentId: "main",
          storePath,
          sessionKey: fixture.key,
          sessionId: fixture.entry.sessionId,
        };
        await replaceSessionEntry(scope, fixture.entry);
        appendTranscriptMessageSync(scope, {
          message: { role: "user", content: "Verify the retained run fixture" },
        });
        appendTranscriptMessageSync(scope, {
          message: {
            role: "assistant",
            content: "The fixture is complete.",
            usage: { input: 100, output: 20 },
          },
        });
      }
      const rowContext = buildSessionListRowMetadataContext({ now: TIMES[0], sessionKeys: [] });
      const subagentRunInputs = {
        runs: new Map((fixture.runs ?? []).map((run) => [run.runId, run])),
        inMemoryRuns: [],
      };
      const runsByChild = new Map<string, SubagentRunRecord[]>();
      for (const run of fixture.runs ?? []) {
        const childKey = run.childSessionKey.trim();
        const runs = runsByChild.get(childKey) ?? [];
        runs.push(run);
        runsByChild.set(childKey, runs);
      }
      rowContext.subagentRunsByChildSessionKey = runsByChild;
      rowContext.subagentRuns = buildSubagentRunReadIndexFromRuns({
        ...subagentRunInputs,
        now: TIMES[0],
      });
      const rowParams = {
        cfg,
        agentId: "main",
        key: fixture.key,
        entry: fixture.entry,
        store: fixture.store ?? (fixture.entry ? { [fixture.key]: fixture.entry } : {}),
        storePath,
        now: TIMES[0],
        rowContext: fixture.omitRowContext ? undefined : rowContext,
        includeSwarmChildren: true,
        skipTranscriptUsageFallback: !fixture.transcript,
        lightweightListRow: !fixture.transcript,
        includeDerivedTitles: fixture.transcript,
        includeLastMessage: fixture.transcript,
      };
      const { inputs, presentation } = readSessionRowInputs(rowParams);
      const clock = vi.spyOn(Date, "now").mockImplementation(() => {
        throw new Error("Materialization must not read the clock");
      });
      let materialized: ReturnType<typeof materializeSessionRow>;
      try {
        materialized = materializeSessionRow(inputs);
      } finally {
        clock.mockRestore();
      }
      const retainedMaterialized = structuredClone(materialized);
      const rows = TIMES.map((now) =>
        decorate(
          presentSessionRow(materialized, {
            ...presentation,
            now,
            subagentRuns: buildSubagentRunReadIndexFromRuns({ ...subagentRunInputs, now }),
          }),
          fixture,
          cfg,
        ),
      );
      const replay = TIMES.map((now) =>
        decorate(
          presentSessionRow(materialized, {
            ...presentation,
            now,
            subagentRuns: undefined,
          }),
          fixture,
          cfg,
        ),
      );
      expect(replay).toStrictEqual(rows);
      expect(replay.map((row) => JSON.stringify(row))).toEqual(
        rows.map((row) => JSON.stringify(row)),
      );
      expect(materialized).toStrictEqual(retainedMaterialized);
      expect(materialized.row.snapshotAt).toBeUndefined();
      rows.forEach((row, index) => {
        expect(row.snapshotAt).toBe(TIMES[index]);
        // Sampling metadata is additive; retain golden coverage of every existing wire field.
        const { snapshotAt: _snapshotAt, ...previousWireFields } = row;
        const json = JSON.stringify(previousWireFields);
        const actualHash = createHash("sha256").update(json).digest("hex");
        const expectedHash = GOLDEN_HASHES[fixture.name]?.[index];
        if (actualHash !== expectedHash) {
          // openclaw-temp-dir: allow failure diagnostics live until the Vitest wrapper cleans its namespace
          const directory = mkdtempSync(path.join(tmpdir(), "openclaw-row-golden-mismatch-"));
          const actualPath = path.join(directory, `${TIMES[index]}.json`);
          writeFileSync(actualPath, json);
          throw new Error(
            `${fixture.name} at ${TIMES[index]}: expected SHA256 ${expectedHash}, ` +
              `actual SHA256 ${actualHash}; actual canonical JSON: ${actualPath}\n${json}`,
          );
        }
      });
      if (fixture.transcript) {
        const lightweight = buildGatewaySessionRow({ ...rowParams, lightweightListRow: true });
        expect(lightweight.totalTokens).toBe(rows[0]?.totalTokens);
        expect(lightweight.totalTokens).toBeGreaterThan(0);
        expect(lightweight.estimatedCostUsd).toBe(fixture.entry?.estimatedCostUsd);
      }
      if (fixture.key === RETAINED) {
        expect(rows.map((row) => row.controlOwnerSessionKey)).toEqual([
          "agent:main:parent-a",
          "agent:main:parent-a",
          "agent:main:parent-b",
        ]);
        expect(rows[0]?.estimatedCostUsd).not.toEqual(rows[2]?.estimatedCostUsd);
      }
    }
  });
});
