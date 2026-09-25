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
    "e2a55b2ea688314c6f6f752b3e873ca4aa57e4e79663f91fd43eecf05fa41885",
    "e2a55b2ea688314c6f6f752b3e873ca4aa57e4e79663f91fd43eecf05fa41885",
    "e2a55b2ea688314c6f6f752b3e873ca4aa57e4e79663f91fd43eecf05fa41885",
  ],
  "activity stale and uncorrelated placement": [
    "0c3281eb7ee63b1fd7d2b787014c0c7bc2603cbe008cf4c6850a75adb3a15947",
    "0c3281eb7ee63b1fd7d2b787014c0c7bc2603cbe008cf4c6850a75adb3a15947",
    "0c3281eb7ee63b1fd7d2b787014c0c7bc2603cbe008cf4c6850a75adb3a15947",
  ],
  "child retention keeps canonical live recent and unknown links": [
    "0cae0637ed16977b969ee17061753770f7ab5558f6b53020cb0bfedeed86baf7",
    "0cae0637ed16977b969ee17061753770f7ab5558f6b53020cb0bfedeed86baf7",
    "eb00b05f876e3a6ffd05d83f8326fc95b6de0711ea6a1f34b4d6c0edcca96d83",
  ],
  "ended run uses persisted lifecycle timestamps": [
    "012c763d714dfa2bab8a74e4456e5901c39b2143ac6bc69442e017f0bb1696c0",
    "012c763d714dfa2bab8a74e4456e5901c39b2143ac6bc69442e017f0bb1696c0",
    "012c763d714dfa2bab8a74e4456e5901c39b2143ac6bc69442e017f0bb1696c0",
  ],
  "expired status and incognito draft": [
    "eb2a33691221b6a9657f8a9ddf6e1cfe59fd21010b986529c7fea9b2a1899741",
    "eb2a33691221b6a9657f8a9ddf6e1cfe59fd21010b986529c7fea9b2a1899741",
    "eb2a33691221b6a9657f8a9ddf6e1cfe59fd21010b986529c7fea9b2a1899741",
  ],
  "goal below budget retains committed timestamps": [
    "a377ee813acd6c1281a2033b9051181ee78af2540b75056ab393c47861c0111d",
    "a377ee813acd6c1281a2033b9051181ee78af2540b75056ab393c47861c0111d",
    "a377ee813acd6c1281a2033b9051181ee78af2540b75056ab393c47861c0111d",
  ],
  "goal budget becomes limited at presentation time": [
    "836a92f3887f12c9e90d05d412dae45e53de42d30a09c39d9a00e0c2358419e8",
    "d7ebd437bbd7ac5e2f73c947636107af9dccc0f2651b75363660f0a3248cfe2a",
    "fdaec3dfabb1d53680cfe8710aae71b91c53565e1ec2552bc6c53f7a446801ce",
  ],
  "live status and persisted running lifecycle": [
    "6327b662602af8002f34f33ab38e9bd0371abaae07c2d292ee9e33c0fc29d1e1",
    "f3ca6da45e94eff4466d464b54ac75fd7804021a847ce4a4d2d56a3c348db389",
    "f3ca6da45e94eff4466d464b54ac75fd7804021a847ce4a4d2d56a3c348db389",
  ],
  "live subagent accumulated runtime and inherited model": [
    "7b9e06e2824e1271a6062b7b444c60e7bfda0f5c5167bb21855234c765c7dd5c",
    "7b9e06e2824e1271a6062b7b444c60e7bfda0f5c5167bb21855234c765c7dd5c",
    "7b9e06e2824e1271a6062b7b444c60e7bfda0f5c5167bb21855234c765c7dd5c",
  ],
  "missing entry": [
    "673c00f270f9c69abf1dcf79e19ca0c1ca972effe90aaf5d054a913d3b6aaf5f",
    "673c00f270f9c69abf1dcf79e19ca0c1ca972effe90aaf5d054a913d3b6aaf5f",
    "673c00f270f9c69abf1dcf79e19ca0c1ca972effe90aaf5d054a913d3b6aaf5f",
  ],
  "observer digest equal than run start": [
    "a7f47952eb00f121afe2e5b62084fd059f260c62d5e1299fb136d13160cefa9b",
    "a7f47952eb00f121afe2e5b62084fd059f260c62d5e1299fb136d13160cefa9b",
    "a7f47952eb00f121afe2e5b62084fd059f260c62d5e1299fb136d13160cefa9b",
  ],
  "observer digest newer than run start": [
    "95dfed0cc2c3242101da877ae1dd4060fd5b935ff2ef0aca5182dea0aef9f7b1",
    "95dfed0cc2c3242101da877ae1dd4060fd5b935ff2ef0aca5182dea0aef9f7b1",
    "95dfed0cc2c3242101da877ae1dd4060fd5b935ff2ef0aca5182dea0aef9f7b1",
  ],
  "observer digest older than run start": [
    "4e71761f1cab4145df872db5b268afdc3d35e0ef8dff618a2d7518a7ba643c53",
    "4e71761f1cab4145df872db5b268afdc3d35e0ef8dff618a2d7518a7ba643c53",
    "4e71761f1cab4145df872db5b268afdc3d35e0ef8dff618a2d7518a7ba643c53",
  ],
  "retention changes control owner and transcript fallback cost": [
    "9d43061a96a7aeb0d8f1bf362f965d30b8e8e4bcd82c3ee6585a456a2c32bb51",
    "9d43061a96a7aeb0d8f1bf362f965d30b8e8e4bcd82c3ee6585a456a2c32bb51",
    "0a5c6dd1f3f0ca6f089d8fbb7cd377ed09f4760a6a5b1d7e5bbbe5be14995976",
  ],
  "single-row snapshot without an explicit swarm context": [
    "6cea6513506ee5916a269cd83f18480f916be4a02b35de4d26139253f43eb8f6",
    "6cea6513506ee5916a269cd83f18480f916be4a02b35de4d26139253f43eb8f6",
    "6cea6513506ee5916a269cd83f18480f916be4a02b35de4d26139253f43eb8f6",
  ],
  "swarm summary retains collector completion and children": [
    "6f100aeae6cdc44c358ce9de5d50d26be0e8e1dca1da7a717b313ef5747e34f7",
    "6f100aeae6cdc44c358ce9de5d50d26be0e8e1dca1da7a717b313ef5747e34f7",
    "6f100aeae6cdc44c358ce9de5d50d26be0e8e1dca1da7a717b313ef5747e34f7",
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
