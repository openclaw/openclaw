import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { buildSubagentRunReadIndexFromRuns } from "../agents/subagents/registry/subagent-registry-queries.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
const TIMES = [START + 29_999, START + 30_000, START + 7_200_001];
const KEY = "agent:main:dashboard:materialize";
const BASE_ENTRY = { sessionId: "session", updatedAt: START, createdAt: START - 1_000 };
const cfg: OpenClawConfig = {
  agents: {
    defaults: { reasoningDefault: "stream" },
    entries: { main: {}, ops: { reasoningDefault: "on" } },
  },
};

function rowParams(
  entry?: SessionEntry,
  overrides: Partial<Parameters<typeof readSessionRowInputs>[0]> = {},
) {
  return {
    cfg,
    agentId: "main",
    key: KEY,
    entry,
    store: entry ? { [KEY]: entry } : {},
    storePath: "",
    now: START,
    skipTranscriptUsageFallback: true,
    lightweightListRow: true,
    ...overrides,
  };
}

const read = (...args: Parameters<typeof rowParams>) => readSessionRowInputs(rowParams(...args));

beforeEach(() => {
  setRuntimeConfigSnapshot(cfg);
  setActivePluginRegistry(createEmptyPluginRegistry());
});
afterEach(() => {
  resetConfigRuntimeState();
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

test("projects the configured reasoning default a session inherits", () => {
  const row = (agentId: string) => {
    const key = `agent:${agentId}:main`;
    return buildGatewaySessionRow(
      rowParams(BASE_ENTRY, { agentId, key, store: { [key]: BASE_ENTRY } }),
    );
  };
  const opsRow = row("ops");
  expect(opsRow.reasoningDefault).toBe("on");
  expect(buildGatewaySessionSnapshot({ sessionRow: opsRow }).reasoningDefault).toBe("on");
  expect(row("main").reasoningDefault).toBe("stream");
});

test("materializes without a clock and presents equivalent indexed and fallback snapshots without mutation", async () => {
  await withStateDirEnv("openclaw-row-materialize-", async ({ stateDir }) => {
    const key = "agent:main:subagent:materialize";
    const entry = {
      ...BASE_ENTRY,
      status: "failed" as const,
      startedAt: START - 500,
      endedAt: START + 1_000,
      runtimeMs: 1_500,
      lastRunError: "Synthetic failure",
    };
    const originalEntry = structuredClone(entry);
    const run = createSubagentRunRecord({
      runId: "materialize-ended",
      childSessionKey: key,
      requesterSessionKey: KEY,
      createdAt: START - 1_000,
      startedAt: START,
      endedAt: START + 100,
    });
    const runInputs = { runs: new Map([[run.runId, run]]), inMemoryRuns: [] };
    const rowContext = buildSessionListRowMetadataContext({ now: START, sessionKeys: [] });
    rowContext.subagentRunsByChildSessionKey = new Map([[key, [run]]]);
    rowContext.subagentRuns = buildSubagentRunReadIndexFromRuns({ ...runInputs, now: START });
    const { inputs, presentation } = read(entry, {
      key,
      rowContext,
      store: { [key]: entry },
      storePath: path.join(stateDir, "agents", "main", "sessions", "sessions.json"),
    });
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
    for (const now of TIMES) {
      const row = presentSessionRow(materialized, { ...presentation, now });
      const indexed = presentSessionRow(materialized, {
        ...presentation,
        now,
        subagentRuns: buildSubagentRunReadIndexFromRuns({ ...runInputs, now }),
      });
      expect(indexed).toStrictEqual(row);
      expect(JSON.stringify(indexed)).toBe(JSON.stringify(row));
      expect(structuredClone(row)).toMatchObject({
        snapshotAt: now,
        updatedAt: START,
        status: "failed",
        startedAt: START - 500,
        endedAt: START + 1_000,
        runtimeMs: 1_500,
        lastRunError: "Synthetic failure",
      });
      expect(row.spawnedBy).toBeUndefined();
      expect(row.controlOwnerSessionKey).toBeUndefined();
    }
    expect(materialized).toStrictEqual(retained);
    expect(materialized.row.snapshotAt).toBeUndefined();
    expect(entry).toStrictEqual(originalEntry);
  });
});

test("retains durable child navigation after display retention without reviving runtime control", () => {
  const children = ["live", "done", "unknown", "stale"].map(
    (name) => `agent:main:subagent:${name}`,
  );
  const store: Record<string, SessionEntry> = { [KEY]: BASE_ENTRY };
  children.forEach((key, index) => {
    store[key] = {
      ...BASE_ENTRY,
      parentSessionKey: KEY,
      ...(index === 1 ? { status: "done", endedAt: START } : {}),
      ...(index === 3 ? { updatedAt: START - 7_200_000 } : {}),
    };
  });
  const { inputs, presentation } = read(BASE_ENTRY, { store });
  const materialized = materializeSessionRow(inputs);
  for (const now of TIMES) {
    const row = presentSessionRow(materialized, { ...presentation, now });
    expect(row.childSessions).toEqual(children);
    expect(row.controlOwnerSessionKey).toBeUndefined();
  }
});

test.each([-1, 0, 1])(
  "projects only an observer digest newer than the run start (offset %i)",
  (offset) => {
    const observerDigest = {
      sessionKey: KEY,
      agentId: "main",
      runId: "observer-run",
      headline: "The fixture is ready",
      health: "wrapping-up" as const,
      updatedAt: START + offset,
      revision: 3,
    };
    const { inputs } = read({ ...BASE_ENTRY, startedAt: START, observerDigest });
    const row = materializeSessionRow(inputs).row;
    expect(row.observerDigest).toEqual(
      offset > 0
        ? {
            agentId: "main",
            runId: "observer-run",
            headline: "The fixture is ready",
            health: "wrapping-up",
            updatedAt: START + 1,
            revision: 3,
          }
        : undefined,
    );
  },
);

test.each([50, 150])(
  "projects goal accounting at presentation time for %i tokens without committing it",
  (totalTokens) => {
    const goal: NonNullable<SessionEntry["goal"]> = {
      schemaVersion: 1,
      id: "goal",
      objective: "Finish",
      status: "active",
      createdAt: START - 1_000,
      updatedAt: START,
      tokenStart: 20,
      tokenStartFresh: true,
      tokensUsed: 5,
      tokenBudget: 100,
      continuationTurns: 2,
    };
    const { inputs, presentation } = read({
      ...BASE_ENTRY,
      goal,
      totalTokens,
      totalTokensFresh: true,
      totalTokensVersion: 1,
    });
    const materialized = materializeSessionRow(inputs);
    for (const now of TIMES) {
      const projected = presentSessionRow(materialized, { ...presentation, now }).goal;
      expect(projected).toMatchObject({
        tokensUsed: totalTokens - 20,
        status: totalTokens < 100 ? "active" : "budget_limited",
        updatedAt: totalTokens < 100 ? START : now,
      });
      expect(projected?.budgetLimitedAt).toBe(totalTokens < 100 ? undefined : now);
    }
    expect(goal).toMatchObject({ status: "active", updatedAt: START, tokensUsed: 5 });
  },
);

test("keeps incognito draft facts while expiring transient status", () => {
  const { inputs, presentation } = read({
    ...BASE_ENTRY,
    visibility: "draft",
    incognito: true,
    agentStatus: { note: "Expired", expiresAt: START - 1 },
    pinnedAt: START,
    label: "Private",
  });
  const row = presentSessionRow(materializeSessionRow(inputs), presentation);
  expect(row).toMatchObject({
    visibility: "draft",
    incognito: true,
    pinnedAt: START,
    label: "Private",
    effectiveCommunication: { send: "always", receive: "always" },
  });
  expect(row.agentStatus).toBeUndefined();
  expect(row.communication).toBeUndefined();
});

test("presents a missing entry without manufacturing stored session facts", () => {
  const { inputs, presentation } = read();
  const row = presentSessionRow(materializeSessionRow(inputs), presentation);
  expect(row).toMatchObject({ key: KEY, updatedAt: null, snapshotAt: START });
  expect(row.sessionId).toBeUndefined();
});
