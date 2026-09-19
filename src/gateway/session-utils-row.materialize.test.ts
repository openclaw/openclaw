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
const START = Date.UTC(2026, 8, 15);
const TIMES = [START + 29_999, START + 30_000, START + 7_200_001] as const;
const GOLDEN_HASHES: Record<string, readonly [string, string, string]> = {
  "ACP metadata owns the runtime": [
    "8663e7d988e076ebebce9c1e3a657ef210162af9db649e4efe887a5fdd53508b",
    "8663e7d988e076ebebce9c1e3a657ef210162af9db649e4efe887a5fdd53508b",
    "8663e7d988e076ebebce9c1e3a657ef210162af9db649e4efe887a5fdd53508b",
  ],
  "activity current and active correlated placement": [
    "4ccd175adb58b964bfe852c187cc6d1846eba8594910339707fb522e9e9d4312",
    "4ccd175adb58b964bfe852c187cc6d1846eba8594910339707fb522e9e9d4312",
    "4ccd175adb58b964bfe852c187cc6d1846eba8594910339707fb522e9e9d4312",
  ],
  "activity stale and uncorrelated placement": [
    "18aa52bb3b38aabaf056b89c801835520bbe6d3af8840f99c713e1b38e12e25f",
    "18aa52bb3b38aabaf056b89c801835520bbe6d3af8840f99c713e1b38e12e25f",
    "18aa52bb3b38aabaf056b89c801835520bbe6d3af8840f99c713e1b38e12e25f",
  ],
  "child retention keeps canonical live recent and unknown links": [
    "ececdbe0d4490726880d13bb07b0a5167b5914872afef40ecbf112c407489754",
    "ececdbe0d4490726880d13bb07b0a5167b5914872afef40ecbf112c407489754",
    "5306a0df8b9990d2bd4be6c55b7eb666cb027e3101854304280f7cc592d008f0",
  ],
  "ended run uses persisted lifecycle timestamps": [
    "9736e9ecceed7407684f4dfc1b3ee4061986aa6bc791f536d0c8bb7221d4ac97",
    "9736e9ecceed7407684f4dfc1b3ee4061986aa6bc791f536d0c8bb7221d4ac97",
    "9736e9ecceed7407684f4dfc1b3ee4061986aa6bc791f536d0c8bb7221d4ac97",
  ],
  "expired status and incognito draft": [
    "3243983d0745f0851191af59fa1cf20dc9c7e8959f0c8f8cf175ff1f5b6c5d51",
    "3243983d0745f0851191af59fa1cf20dc9c7e8959f0c8f8cf175ff1f5b6c5d51",
    "3243983d0745f0851191af59fa1cf20dc9c7e8959f0c8f8cf175ff1f5b6c5d51",
  ],
  "goal below budget retains committed timestamps": [
    "17e019c6ff826f062ef0ef6e9c645d8cdbaaf2bc97cc335ebba2f8a2ca1dbd8f",
    "17e019c6ff826f062ef0ef6e9c645d8cdbaaf2bc97cc335ebba2f8a2ca1dbd8f",
    "17e019c6ff826f062ef0ef6e9c645d8cdbaaf2bc97cc335ebba2f8a2ca1dbd8f",
  ],
  "goal budget becomes limited at presentation time": [
    "52fd5c3954ae3279ee8dcb30605c9601938558c3986869bc78cc7af5f3edc79e",
    "f02cd63765bc2909862a02b002fe7b2e1ba3636fd132f2e25b61c54983770208",
    "f065d5512ae73768c25381f91055afe4b91e870576751267db9808d8613f4b1e",
  ],
  "live status and persisted running lifecycle": [
    "fd49da86c424999b929869a33753bd95ac4047d403d89623ba7bb808d99840ca",
    "9c1e8405a1a309579268e1d5dcf1a7b75f839fe38c168f3b353d2f096aceb625",
    "9c1e8405a1a309579268e1d5dcf1a7b75f839fe38c168f3b353d2f096aceb625",
  ],
  "live subagent accumulated runtime and inherited model": [
    "53f20e4308efa5675ff97c3b3ebb922225af4fb4ea2012338caa46bbf1e83ca2",
    "53f20e4308efa5675ff97c3b3ebb922225af4fb4ea2012338caa46bbf1e83ca2",
    "53f20e4308efa5675ff97c3b3ebb922225af4fb4ea2012338caa46bbf1e83ca2",
  ],
  "missing entry": [
    "9ff00bdab73d537bcf96bdd981f6b6945ae14d90b64a12ae0367bd7b37986d56",
    "9ff00bdab73d537bcf96bdd981f6b6945ae14d90b64a12ae0367bd7b37986d56",
    "9ff00bdab73d537bcf96bdd981f6b6945ae14d90b64a12ae0367bd7b37986d56",
  ],
  "observer digest equal than run start": [
    "bfa3265fc4cfdefa4dbac91e692975c730bd2e4eafa5d98867c892075df99ba9",
    "bfa3265fc4cfdefa4dbac91e692975c730bd2e4eafa5d98867c892075df99ba9",
    "bfa3265fc4cfdefa4dbac91e692975c730bd2e4eafa5d98867c892075df99ba9",
  ],
  "observer digest newer than run start": [
    "480b0a6abdac05a381c0a2d2e7032f8b0e7a4fff421e9fb8483537ec0136db16",
    "480b0a6abdac05a381c0a2d2e7032f8b0e7a4fff421e9fb8483537ec0136db16",
    "480b0a6abdac05a381c0a2d2e7032f8b0e7a4fff421e9fb8483537ec0136db16",
  ],
  "observer digest older than run start": [
    "bed18bbaef6e34f3f160c2f43edd4d12d62cd7af3630160ea4d0058f6bfb7ae5",
    "bed18bbaef6e34f3f160c2f43edd4d12d62cd7af3630160ea4d0058f6bfb7ae5",
    "bed18bbaef6e34f3f160c2f43edd4d12d62cd7af3630160ea4d0058f6bfb7ae5",
  ],
  "retention changes control owner and transcript fallback cost": [
    "d6953fcaad8f6ccbb2a3a279147628b07f07daf411bff6b4ec5029c4c839b32e",
    "d6953fcaad8f6ccbb2a3a279147628b07f07daf411bff6b4ec5029c4c839b32e",
    "4862244efb75ff8d63e7eef771fd9f78efa92eacd3950b6a9384880a1e725068",
  ],
  "single-row snapshot without an explicit swarm context": [
    "55567cdb98a1b3b985dc9c7ca03307ebc28693c62ce92366edb5cff127c3b257",
    "55567cdb98a1b3b985dc9c7ca03307ebc28693c62ce92366edb5cff127c3b257",
    "55567cdb98a1b3b985dc9c7ca03307ebc28693c62ce92366edb5cff127c3b257",
  ],
  "swarm summary retains collector completion and children": [
    "a3be685234dbb4a3a2e09aae9c1e31ce3e848ce8fdc61b25b63a0476269aa39c",
    "a3be685234dbb4a3a2e09aae9c1e31ce3e848ce8fdc61b25b63a0476269aa39c",
    "a3be685234dbb4a3a2e09aae9c1e31ce3e848ce8fdc61b25b63a0476269aa39c",
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
