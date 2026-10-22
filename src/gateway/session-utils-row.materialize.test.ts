import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { buildSubagentRunReadIndexFromRuns } from "../agents/subagents/registry/subagent-registry-queries.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { InternalSessionEntry, SessionEntry } from "../config/sessions.js";
import { ACTIVITY_SUMMARY_FORMAT_REVISION } from "../config/sessions/activity-summary.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { projectSessionActivitySummary } from "./session-activity-summary-state.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";
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
import { activePlacement } from "./worker-environments/placement-suite.test-support.js";

// Values frozen from d70a7e7300cdc0af4485d10b39f3e4986c3dd155.
// SHA256 pins wire values; sparse materialization may change top-level property order.
const START = Date.UTC(2026, 8, 15);
const TIMES = [START + 29_999, START + 30_000, START + 7_200_001] as const;
const GOLDEN_HASHES: Record<string, string | readonly [string, string, string]> = {
  "ACP metadata owns the runtime":
    "806dd091c364088ac97e34825c6bdaee6e865b6ff911a6b54c2073c05b28afb5",
  "activity current and active correlated placement":
    "03b2a5f8df56d4c6b58c33838ff1a2a7ceeb555d95332d4e936bc32d20fd7995",
  "activity stale and uncorrelated placement":
    "44f6c17648306a69451dea4079e7f325eedb3a58c24eeac47af07c3e011ffb95",
  "child retention keeps canonical live recent and unknown links": [
    "02c9c8267711adf6e3673b9fa35c0e63694b400d5af718d1ab84f69e52e49ecd",
    "02c9c8267711adf6e3673b9fa35c0e63694b400d5af718d1ab84f69e52e49ecd",
    "556f0f870c08fbf3b5d218d2328ba4c6dff0943bbc3a82d8858a5f57620132a2",
  ],
  "ended run uses persisted lifecycle timestamps":
    "3812cd64fb99bf06451eaebd5d722e38212834e453f21d01afbce70518a2f71e",
  "expired status and incognito draft":
    "fc06ca39632d330036ebab35135098ac12d6b22b4f5a0c0ed36b7f7c559474e6",
  "goal below budget retains committed timestamps":
    "1aaecea18cfa924f2714e47af426dc76fc1bd8b30dae956206e7cbe6f9199001",
  "goal budget becomes limited at presentation time": [
    "26b22c9c15b44c86fdbc6d403d4152168e2fa8651be2dfb03bd26fd4d30b9b11",
    "89b735377c12bf3bd9b4a050c2d89aabe763b4dfe53da7caa7ee6f1b4acaacd5",
    "e17984f9316f106afb181d5bfd1f952945e85e9a32b860420ab5d65130d7a1fa",
  ],
  "live subagent accumulated runtime and inherited model":
    "ec1fab32f0b68de7cf6bab6e0c6bcab8b79382492b710b041f40c53ad7538e6e",
  "missing entry": "ca59b3ec3a664a3caa055671a6e57891e8a9b072c0509e8073576ab8b80de292",
  "observer digest equal than run start":
    "4abca444a5d0be3ff30b99147ab9d17c073bb440ce3e1175007718d5bcda51d3",
  "observer digest newer than run start":
    "7cc823b5a30bba6938e56df9285e373a50710a5227643a7ee414a6b84cc88ff8",
  "observer digest older than run start":
    "ab9085aa5476af8045a0ffdac062f7a380f223cde9842bbe9a88b422fbb7a147",
  "single-row snapshot without an explicit swarm context":
    "495b2e3d130365dfdd9aaa322cd655f4d11f2cae5e673cc98a3e1369b1231dae",
  "swarm summary retains collector completion and children":
    "194b69b9172baad7878f5c67e7be312f101420979c71058e5603b6e451901be1",
};

const PARENT = "agent:main:dashboard:parent";
const LIVE = "agent:main:subagent:live";
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
  acpMeta?: SessionEntry["acp"];
  store?: Record<string, SessionEntry>;
  runs?: SubagentRunRecord[];
  omitRowContext?: boolean;
  expectedIsDock?: boolean;
  decoration?: "current" | "stale";
};

function config(): OpenClawConfig {
  return {
    agents: {
      entries: { main: { identity: { name: "Fixture agent" } } },
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
  const goalFixture = (
    name: string,
    suffix: string,
    totalTokens: number,
    goal = GOAL,
  ): RowFixture => ({
    name,
    key: `agent:main:dashboard:${suffix}`,
    entry: { ...BASE_ENTRY, goal, totalTokens, totalTokensFresh: true, totalTokensVersion: 1 },
  });
  return [
    { name: "missing entry", key: "agent:main:dashboard:missing" },
    {
      name: "single-row snapshot without an explicit swarm context",
      key: "agent:main:dashboard:single",
      entry: { ...BASE_ENTRY, createdSurface: "plugin-dock" },
      omitRowContext: true,
      expectedIsDock: true,
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
    goalFixture("goal budget becomes limited at presentation time", "budget", 150),
    goalFixture("goal below budget retains committed timestamps", "goal", 50, {
      ...GOAL,
      tokensUsed: 5,
    }),
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
      entry: BASE_ENTRY,
      acpMeta: {
        backend: "acpx",
        agent: "fixture",
        runtimeSessionName: "golden-acp",
        mode: "persistent",
        state: "idle",
        lastActivityAt: START,
      },
    },
    ...(["current", "stale"] as const).map((decoration) => ({
      name:
        decoration === "current"
          ? "activity current and active correlated placement"
          : "activity stale and uncorrelated placement",
      key: `agent:main:dashboard:activity-${decoration}`,
      entry: activityEntry,
      decoration,
    })),
  ];
}

function decorate(row: GatewaySessionRow, fixture: RowFixture, cfg: OpenClawConfig) {
  if (!fixture.decoration) {
    return row;
  }
  const current = fixture.decoration === "current";
  const placement = activePlacement(BASE_ENTRY.sessionId, {
    sessionKey: fixture.key,
    generation: 4,
    environmentId: "golden-environment",
    activeOwnerEpoch: 7,
    workspaceBaseManifestRef: "golden-manifest",
    createdAtMs: START - 1_000,
    updatedAtMs: START,
    stateChangedAtMs: START,
  });
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

test("projects the configured reasoning default a session inherits", () => {
  const cfg: OpenClawConfig = {
    agents: {
      defaults: { reasoningDefault: "stream" },
      entries: { main: {}, ops: { reasoningDefault: "on" } },
    },
  };
  setRuntimeConfigSnapshot(cfg);
  setActivePluginRegistry(createEmptyPluginRegistry());
  const row = (agentId: string) => {
    const key = `agent:${agentId}:main`;
    return buildGatewaySessionRow({
      cfg,
      agentId,
      key,
      entry: BASE_ENTRY,
      store: { [key]: BASE_ENTRY },
      storePath: "",
      now: START,
      skipTranscriptUsageFallback: true,
      lightweightListRow: true,
    });
  };

  const opsRow = row("ops");
  expect(opsRow.reasoningDefault).toBe("on");
  expect(buildGatewaySessionSnapshot({ sessionRow: opsRow }).reasoningDefault).toBe("on");
  expect(row("main").reasoningDefault).toBe("stream");
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
      const originalEntry = structuredClone(fixture.entry);
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
        preparedAcpMeta: fixture.acpMeta ?? null,
        store: fixture.store ?? (fixture.entry ? { [fixture.key]: fixture.entry } : {}),
        storePath,
        now: TIMES[0],
        rowContext: fixture.omitRowContext ? undefined : rowContext,
        includeSwarmChildren: true,
        skipTranscriptUsageFallback: true,
        lightweightListRow: true,
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
      const present = (indexed: boolean) =>
        TIMES.map((now) =>
          decorate(
            presentSessionRow(materialized, {
              ...presentation,
              now,
              subagentRuns: indexed
                ? buildSubagentRunReadIndexFromRuns({ ...subagentRunInputs, now })
                : undefined,
            }),
            fixture,
            cfg,
          ),
        );
      const rows = present(true);
      const replay = present(false);
      expect(replay).toStrictEqual(rows);
      expect(replay.map((row) => JSON.stringify(row))).toEqual(
        rows.map((row) => JSON.stringify(row)),
      );
      expect(materialized).toStrictEqual(retainedMaterialized);
      expect(materialized.row.snapshotAt).toBeUndefined();
      rows.forEach((row, index) => {
        expect(structuredClone(row).snapshotAt).toBe(TIMES[index]);
        expect(row).toMatchObject({
          snapshotAt: TIMES[index],
          isDock: fixture.expectedIsDock ?? false,
          sessionModelRevision: expect.any(String),
          sidebarRoot: fixture.entry?.sidebarRoot === true,
          effectiveCommunication: { send: "always", receive: "always" },
        });
        expect(row.createdSurface).toBe(fixture.entry?.createdSurface);
        expect(row.communication).toBeUndefined();
        const {
          snapshotAt: _snapshotAt,
          createdSurface: _createdSurface,
          isDock: _isDock,
          sessionModelRevision: _sessionModelRevision,
          communication: _communication,
          effectiveCommunication: _effectiveCommunication,
          sidebarRoot: _sidebarRoot,
          ...previousWireFields
        } = row;
        const json = JSON.stringify(
          Object.fromEntries(
            Object.entries(previousWireFields).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          ),
        );
        const actualHash = createHash("sha256").update(json).digest("hex");
        const hashes = GOLDEN_HASHES[fixture.name];
        const expectedHash = typeof hashes === "string" ? hashes : hashes?.[index];
        expect(actualHash, `${fixture.name} at ${TIMES[index]}\n${json}`).toBe(expectedHash);
      });
      expect(fixture.entry).toStrictEqual(originalEntry);
    }
  });
});
