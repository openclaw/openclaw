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

// Frozen from 7b47d7a65a17e7a49d943795a5b112ae4adcfe3c; updated only for additive Ultra choices.
// SHA256 pins JSON.stringify wire bytes, including serialized property order.
const START = Date.UTC(2026, 8, 15);
const TIMES = [START + 29_999, START + 30_000, START + 7_200_001] as const;
const GOLDEN_HASHES: Record<string, readonly [string, string, string]> = {
  "ACP metadata owns the runtime": [
    "8663e7d988e076ebebce9c1e3a657ef210162af9db649e4efe887a5fdd53508b",
    "8663e7d988e076ebebce9c1e3a657ef210162af9db649e4efe887a5fdd53508b",
    "8663e7d988e076ebebce9c1e3a657ef210162af9db649e4efe887a5fdd53508b",
  ],
  "activity current and active correlated placement": [
    "e627d174fba0e16a93597370ec813d757d91d87395695c31954cc9cb5ce3669b",
    "e627d174fba0e16a93597370ec813d757d91d87395695c31954cc9cb5ce3669b",
    "e627d174fba0e16a93597370ec813d757d91d87395695c31954cc9cb5ce3669b",
  ],
  "activity stale and uncorrelated placement": [
    "e0cc8bb8123fc35e8510b79c1bb9369fe05d69c7fda9172d066664b0c12b9b6a",
    "e0cc8bb8123fc35e8510b79c1bb9369fe05d69c7fda9172d066664b0c12b9b6a",
    "e0cc8bb8123fc35e8510b79c1bb9369fe05d69c7fda9172d066664b0c12b9b6a",
  ],
  "child retention keeps canonical live recent and unknown links": [
    "6f112eca27fe78b2b465ce23bef1a491945d749d77149f74c96d488d14ab2079",
    "6f112eca27fe78b2b465ce23bef1a491945d749d77149f74c96d488d14ab2079",
    "c648339258cd170449ac11880ab233d5116b829687597d6308a6eb937ab49dcf",
  ],
  "ended run uses persisted lifecycle timestamps": [
    "61ce9d8cbf18ab8857404095db01c1d0cfb1dccc5247c4e0ba80dbcd33fc132d",
    "61ce9d8cbf18ab8857404095db01c1d0cfb1dccc5247c4e0ba80dbcd33fc132d",
    "61ce9d8cbf18ab8857404095db01c1d0cfb1dccc5247c4e0ba80dbcd33fc132d",
  ],
  "expired status and incognito draft": [
    "e4dcdcd973ef2be2571559a21c89ed55135ef38e59c4362f5ba071eefcb0e5c9",
    "e4dcdcd973ef2be2571559a21c89ed55135ef38e59c4362f5ba071eefcb0e5c9",
    "e4dcdcd973ef2be2571559a21c89ed55135ef38e59c4362f5ba071eefcb0e5c9",
  ],
  "goal below budget retains committed timestamps": [
    "c7ac0dd0d60fd458bcc3e7dc1274c66ff2263ba10e074ba455158405b4716320",
    "c7ac0dd0d60fd458bcc3e7dc1274c66ff2263ba10e074ba455158405b4716320",
    "c7ac0dd0d60fd458bcc3e7dc1274c66ff2263ba10e074ba455158405b4716320",
  ],
  "goal budget becomes limited at presentation time": [
    "49b9ccdccb43c6ca33e717bf753a26a081acc97dd7774f62e4bcf2929119762f",
    "9bfc840cd113478d41ca63695f4b8132fd99b681ab94b24d9bf999ee1f19e3df",
    "f581d45d04e9301490cafffe57817dd9e13425b1ef7e0f1bee829a6d580d7591",
  ],
  "live status and persisted running lifecycle": [
    "0524604bb6cbe3e494c5496e2268ef8ba93ab6561aa8babcdf3d7084d0193b6b",
    "9f3171d5359d2db405063eeb027118e8596975e5a0c71a6c5efedafecd4d7746",
    "9f3171d5359d2db405063eeb027118e8596975e5a0c71a6c5efedafecd4d7746",
  ],
  "live subagent accumulated runtime and inherited model": [
    "4a833af6b758b95675873d624f26df008768eee039fd1afeac34779426e826c4",
    "4a833af6b758b95675873d624f26df008768eee039fd1afeac34779426e826c4",
    "4a833af6b758b95675873d624f26df008768eee039fd1afeac34779426e826c4",
  ],
  "missing entry": [
    "80d3d3667a0a0ef29e051ba202c1a462005ec0a4d96c237ee0302ca6185c9bf1",
    "80d3d3667a0a0ef29e051ba202c1a462005ec0a4d96c237ee0302ca6185c9bf1",
    "80d3d3667a0a0ef29e051ba202c1a462005ec0a4d96c237ee0302ca6185c9bf1",
  ],
  "observer digest equal than run start": [
    "d1d9d048f7259e3cb460977f949ca1e47746e94c02edcf350cba035e84bd128a",
    "d1d9d048f7259e3cb460977f949ca1e47746e94c02edcf350cba035e84bd128a",
    "d1d9d048f7259e3cb460977f949ca1e47746e94c02edcf350cba035e84bd128a",
  ],
  "observer digest newer than run start": [
    "aca8beaa411b0a3e189561814db7cb5654862ce22cd8a8e4f1da2f84e4836409",
    "aca8beaa411b0a3e189561814db7cb5654862ce22cd8a8e4f1da2f84e4836409",
    "aca8beaa411b0a3e189561814db7cb5654862ce22cd8a8e4f1da2f84e4836409",
  ],
  "observer digest older than run start": [
    "36b676f9aae3e00611fbac03ba7785ad399e1c69dbe759613b5d399e8511b9a6",
    "36b676f9aae3e00611fbac03ba7785ad399e1c69dbe759613b5d399e8511b9a6",
    "36b676f9aae3e00611fbac03ba7785ad399e1c69dbe759613b5d399e8511b9a6",
  ],
  "retention changes control owner and transcript fallback cost": [
    "28ac6cb9f2484f9cae484e69933f552b7afea1a04b4fa2b1e1b76ff3b01061b4",
    "28ac6cb9f2484f9cae484e69933f552b7afea1a04b4fa2b1e1b76ff3b01061b4",
    "708bc5184e4b8f011b96e3dd2f64c3ba39982f3610a2430b36a01823f1033473",
  ],
  "single-row snapshot without an explicit swarm context": [
    "251869ca15900f633ab059427f4f2672bf56bb78d1510dbed8466e383b582d78",
    "251869ca15900f633ab059427f4f2672bf56bb78d1510dbed8466e383b582d78",
    "251869ca15900f633ab059427f4f2672bf56bb78d1510dbed8466e383b582d78",
  ],
  "swarm summary retains collector completion and children": [
    "dfc43e4ef8b97e3fc30bfa8eb92941add9ad2de301baaaee55c75d3d29880384",
    "dfc43e4ef8b97e3fc30bfa8eb92941add9ad2de301baaaee55c75d3d29880384",
    "dfc43e4ef8b97e3fc30bfa8eb92941add9ad2de301baaaee55c75d3d29880384",
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
      destroyRequestedAtMs: null,
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
