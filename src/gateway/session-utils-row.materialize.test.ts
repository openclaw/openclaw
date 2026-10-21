import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { buildSubagentRunReadIndexFromRuns } from "../agents/subagents/registry/subagent-registry-queries.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";
import {
  buildGatewaySessionRow,
  materializeSessionRow,
  presentSessionRow,
  readSessionRowInputs,
} from "./session-utils-row.js";

const START = Date.UTC(2026, 8, 15);
const RUN = "materialize-live";
const KEY = "agent:main:subagent:live";
const entry: SessionEntry = { sessionId: "live", updatedAt: START, createdAt: START - 1_000 };
const cfg: OpenClawConfig = {
  agents: {
    entries: { main: {}, ops: { reasoningDefault: "on" } },
    defaults: {
      model: "row-fixture/primary",
      reasoningDefault: "stream",
      thinkingDefault: "off",
      models: { "row-fixture/primary": { agentRuntime: { id: "pi" } } },
    },
  },
  models: {
    providers: {
      "row-fixture": {
        baseUrl: "https://fixture.invalid/v1",
        api: "openai-completions",
        models: ["primary", "older", "newer"].map((id) => ({
          id,
          name: id,
          reasoning: false,
          input: ["text"],
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 8_192,
        })),
      },
    },
  },
};
function params(overrides: Partial<Parameters<typeof readSessionRowInputs>[0]> = {}) {
  return {
    cfg,
    agentId: "main",
    key: KEY,
    entry,
    store: {},
    storePath: "",
    now: START,
    skipTranscriptUsageFallback: true,
    lightweightListRow: true,
    ...overrides,
  };
}

beforeEach(() => {
  setRuntimeConfigSnapshot(cfg);
  setActivePluginRegistry(createEmptyPluginRegistry());
});
afterEach(() => {
  clearAgentRunContext(RUN);
  resetConfigRuntimeState();
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

test("projects the configured reasoning default a session inherits", () => {
  const ops = buildGatewaySessionRow(params({ agentId: "ops", key: "agent:ops:main" }));
  expect(ops.reasoningDefault).toBe("on");
  expect(buildGatewaySessionSnapshot({ sessionRow: ops }).reasoningDefault).toBe("on");
  expect(buildGatewaySessionRow(params()).reasoningDefault).toBe("stream");
});

test.each([-1, 0, 1])(
  "publishes only an observer digest newer than its run (offset=%s)",
  (offset) => {
    const observerDigest = {
      sessionKey: KEY,
      agentId: "main",
      runId: RUN,
      headline: "The fixture is ready",
      health: "wrapping-up" as const,
      updatedAt: START + offset,
      revision: 3,
    };
    const row = buildGatewaySessionRow(
      params({ entry: { ...entry, startedAt: START, observerDigest } }),
    );
    expect(row.observerDigest).toEqual(
      offset > 0
        ? {
            agentId: "main",
            runId: RUN,
            headline: observerDigest.headline,
            health: "wrapping-up",
            updatedAt: START + offset,
            revision: 3,
          }
        : undefined,
    );
  },
);

test("keeps below-budget goal timestamps and committed input unchanged during presentation", () => {
  const goal: NonNullable<SessionEntry["goal"]> = {
    schemaVersion: 1,
    id: "goal",
    objective: "Finish the fixture",
    status: "active",
    createdAt: START - 1_000,
    updatedAt: START,
    tokenStart: 20,
    tokenStartFresh: true,
    tokensUsed: 5,
    tokenBudget: 100,
    continuationTurns: 2,
  };
  const source = { ...entry, totalTokens: 50, totalTokensFresh: true, totalTokensVersion: 1, goal };
  const before = structuredClone(source);
  for (const now of [START + 30_000, START + 7_200_001]) {
    expect(buildGatewaySessionRow(params({ entry: source, now })).goal).toEqual({
      ...goal,
      tokensUsed: 30,
    });
  }
  expect(source).toStrictEqual(before);
});

test.each([
  {
    name: "missing",
    overrides: { entry: undefined },
    expected: { updatedAt: null, isDock: false },
  },
  {
    name: "dock",
    overrides: { entry: { ...entry, createdSurface: "plugin-dock" } },
    expected: { createdSurface: "plugin-dock", isDock: true },
  },
  {
    name: "ACP",
    overrides: {
      key: "agent:main:acp:fixture",
      preparedAcpMeta: {
        backend: "acpx",
        agent: "fixture",
        runtimeSessionName: "fixture",
        mode: "persistent",
        state: "idle",
        lastActivityAt: START,
      },
    },
    expected: { agentRuntime: { id: "acpx" }, runtimeSelectionLocked: true },
  },
] satisfies Array<{
  name: string;
  overrides: Partial<Parameters<typeof readSessionRowInputs>[0]>;
  expected: object;
}>)("projects $name metadata without explicit swarm context", ({ overrides, expected }) => {
  const row = buildGatewaySessionRow(params(overrides));
  expect(row).toMatchObject({
    sidebarRoot: false,
    effectiveCommunication: { send: "always", receive: "always" },
    ...expected,
  });
  expect(row).not.toHaveProperty("swarm");
});

test("preserves incognito draft and pin fields while expiring status", () => {
  const row = buildGatewaySessionRow(
    params({
      key: "agent:main:dashboard:incognito",
      entry: {
        ...entry,
        visibility: "draft",
        incognito: true,
        pinnedAt: START,
        label: "Private fixture",
        agentStatus: { note: "Expired", expiresAt: START - 1 },
      },
    }),
  );
  expect(row).toMatchObject({
    visibility: "draft",
    incognito: true,
    label: "Private fixture",
    pinned: true,
    pinnedAt: START,
  });
  expect(row.agentStatus).toBeUndefined();
});

test.each([
  { name: "unknown", fields: {}, cutoff: 3_600_000 },
  { name: "ended", fields: { status: "done", endedAt: START }, cutoff: 1_800_000 },
] as const)(
  "expires store-only $name child links without changing the source rows",
  ({ fields, cutoff }) => {
    const parent = "agent:main:parent";
    const parentEntry = { ...entry, sessionId: "parent" };
    const store = {
      [parent]: parentEntry,
      [KEY]: { ...entry, parentSessionKey: parent, ...fields },
    };
    const before = structuredClone(store);
    for (const elapsed of [cutoff, cutoff + 1]) {
      const row = buildGatewaySessionRow(
        params({
          key: parent,
          entry: parentEntry,
          store,
          now: START + elapsed,
        }),
      );
      expect(row.childSessions).toEqual(elapsed === cutoff ? [KEY] : undefined);
    }
    expect(store).toStrictEqual(before);
  },
);

test("materializes without clock reads and reuses immutable inputs across indexed and replayed time", async () => {
  await withStateDirEnv("openclaw-row-materialize-", async () => {
    registerAgentRunContext(RUN, {
      agentId: "main",
      sessionKey: KEY,
      sessionId: entry.sessionId,
      activeModel: { provider: "row-fixture", model: "older" },
    });
    const run = createSubagentRunRecord({
      runId: RUN,
      childSessionKey: KEY,
      requesterSessionKey: "agent:main:parent",
      createdAt: START - 2_000,
      startedAt: START,
      accumulatedRuntimeMs: 500,
      model: "row-fixture/older",
    });
    const runInputs = { runs: new Map([[RUN, run]]), inMemoryRuns: [] };
    const index = (now: number) => buildSubagentRunReadIndexFromRuns({ ...runInputs, now });
    const rowContext = buildSessionListRowMetadataContext({
      now: START,
      subagentRuns: index(START),
    });
    const parent = "agent:main:dashboard:parent";
    const source = { ...entry, parentSessionKey: parent };
    const store = {
      [KEY]: source,
      [parent]: {
        ...entry,
        sessionId: "parent",
        providerOverride: "row-fixture",
        modelOverride: "newer",
        modelOverrideSource: "user" as const,
      },
    };
    const before = structuredClone(source);
    const { inputs, presentation } = readSessionRowInputs(
      params({ entry: source, store, rowContext }),
    );
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Materialization must not read the clock");
    });
    let materialized: ReturnType<typeof materializeSessionRow>;
    try {
      materialized = materializeSessionRow(inputs);
    } finally {
      clock.mockRestore();
    }
    const retained = structuredClone(materialized);
    for (const now of [START + 29_999, START + 30_000, START + 7_200_001]) {
      const indexed = presentSessionRow(materialized, {
        ...presentation,
        now,
        subagentRuns: index(now),
      });
      const replay = presentSessionRow(materialized, {
        ...presentation,
        now,
        subagentRuns: undefined,
      });
      expect(replay).toStrictEqual(indexed);
      expect(JSON.stringify(replay)).toBe(JSON.stringify(indexed));
      expect(indexed).toMatchObject({
        snapshotAt: now,
        sessionModelRevision: expect.any(String),
        modelProvider: "row-fixture",
        model: "newer",
        modelOverrideSource: "inherited",
        activeModelProvider: "row-fixture",
        activeModel: "older",
      });
    }
    expect(materialized).toStrictEqual(retained);
    expect(materialized.row.snapshotAt).toBeUndefined();
    expect(source).toStrictEqual(before);
  });
});
