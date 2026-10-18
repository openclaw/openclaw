import { afterEach, expect, it } from "vitest";
import { saveSubagentRegistryToSqlite } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "../agents/subagents/registry/subagent-registry-state.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../agents/tools/sessions-resolution.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { withEnvAsync } from "../test-utils/env.js";
import { buildGatewaySessionSnapshot as buildSnapshot } from "./session-event-payload.js";
import { listSessionFixture } from "./session-list.test-support.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";
import { buildSessionSwarmSummary as summarize } from "./session-swarm-summary.js";

const parent = "agent:main:dashboard:research";
const groupId = `swarm:${parent}:turn`;
const cfg = { agents: { entries: { main: {}, other: {} } } };

function snapshot(
  row: Partial<NonNullable<Parameters<typeof buildSnapshot>[0]["sessionRow"]>> = {},
  options: Omit<Parameters<typeof buildSnapshot>[0], "sessionRow"> = {},
) {
  return buildSnapshot({
    sessionRow: { key: parent, kind: "direct", updatedAt: 0, ...row },
    ...options,
  });
}

function collector(index: number, overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: `run-${index}`,
    childSessionKey: `agent:main:subagent:${index}`,
    requesterSessionKey: parent,
    requesterAgentId: "main",
    requesterDisplayKey: parent,
    swarmRequesterSessionKey: parent,
    task: "Private child task text must not reach the summary",
    cleanup: "delete",
    collect: true,
    groupId,
    createdAt: 100 + index,
    execution: { status: "terminal", startedAt: 200, endedAt: 300 },
    completion: { required: false, resultText: "Private child result" },
    collectorCompletion: { status: index < 25 ? "done" : "failed" },
    ...overrides,
  };
}

async function listCollectors(
  runs: SubagentRunRecord[],
  overrides: Partial<Parameters<typeof listSessionFixture>[0]> = {},
) {
  return withStateDirEnv("session-swarm-summary-", () =>
    withEnvAsync({ OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" }, async () => {
      setRuntimeConfigSnapshot(overrides.cfg ?? cfg);
      saveSubagentRegistryToSqlite(new Map(runs.map((entry) => [entry.runId, entry])));
      return listSessionFixture({
        cfg,
        storePath: "",
        store: { [parent]: { sessionId: "parent", updatedAt: 400 } },
        opts: {},
        ...overrides,
      });
    }),
  );
}

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  clearSubagentRunsReadCacheForTest();
  clearRuntimeConfigSnapshot();
});

it("counts every retained collector after child sessions are deleted", async () => {
  const result = await listCollectors(Array.from({ length: 30 }, (_, index) => collector(index)));
  expect(result.sessions).toHaveLength(1);
  expect(result.sessions[0]?.swarm).toMatchObject({
    groups: [{ groupId, createdAt: 100, queued: 0, running: 0, done: 25, failed: 5 }],
    otherActiveGroups: 0,
  });
  expect(buildSnapshot({ sessionRow: result.sessions[0]! })).toMatchObject({
    swarm: { groups: [{ done: 25, failed: 5 }] },
  });
  expect(JSON.stringify(result)).not.toContain("Private child");
});

it("does not expose a hidden parent's summary or borrow another parent's collectors", async () => {
  const store = {
    [parent]: { sessionId: "parent", updatedAt: 400 },
    "agent:main:other": { sessionId: "other", updatedAt: 400 },
  };
  const result = await listCollectors([collector(0)], {
    store,
    entryFilter: (key) => key !== parent,
  });
  expect(result.sessions).toHaveLength(1);
  expect(JSON.stringify(result.sessions[0])).not.toContain('"swarm":');
});
it("keeps list payloads compact and selected-parent details bounded without losing totals", () => {
  const runs = Array.from({ length: 300 }, (_, index) => collector(index));
  runs.push(
    collector(300, {
      collectorCompletion: undefined,
      execution: { status: "running", startedAt: 300 },
    }),
  );
  const summary = summarize(runs, parent, "main");
  expect(summary?.groups[0]).toMatchObject({ running: 1, done: 25, failed: 275 });
  expect(summary?.groups[0]).not.toHaveProperty("children");
  const detailed = summarize(runs, parent, "main", { includeChildren: true });
  expect(detailed?.groups[0]?.children).toHaveLength(64);
  expect(detailed?.groups[0]?.children?.[0]).toEqual({
    sessionKey: "agent:main:subagent:300",
    status: "running",
  });
  expect(snapshot({ swarm: detailed }).swarm).toEqual(summary);
});

it("separates global owners even when they reuse a custom group id", () => {
  const globalOwner = {
    requesterSessionKey: "global",
    swarmRequesterSessionKey: "global",
    groupId: "review",
  };
  const runs = [
    collector(0, globalOwner),
    collector(25, { ...globalOwner, requesterAgentId: "other" }),
  ];
  expect(summarize(runs, "global", "main")?.groups).toMatchObject([
    { groupId: "review", done: 1, failed: 0 },
  ]);
  expect(summarize(runs, "global", "other", { includeChildren: true })?.groups).toMatchObject([
    {
      groupId: "review",
      done: 0,
      failed: 1,
      children: [{ sessionKey: "agent:main:subagent:25", status: "failed" }],
    },
  ]);
});

it.each(["workspace", "global"])(
  "joins admitted global-scope %s collectors to their owner row",
  async (suffix) => {
    const globalConfig = { ...cfg, session: { scope: "global" as const, mainKey: "workspace" } };
    const admitted = resolveSessionStoreIdentity({
      cfg: globalConfig,
      sessionKey: `agent:other:${suffix}`,
    });
    const { alias } = resolveMainSessionAlias(globalConfig);
    const requesterKey = resolveInternalSessionKey({ key: admitted.canonicalKey, alias });
    expect(requesterKey).toBe(suffix === "global" ? "agent:other:global" : "global");
    const result = await listCollectors(
      [
        collector(0, {
          swarmRequesterSessionKey: requesterKey,
          requesterSessionKey: requesterKey,
          requesterAgentId: admitted.agentId,
        }),
      ],
      {
        cfg: globalConfig,
        store: { [admitted.canonicalKey]: { sessionId: "global-owner", updatedAt: 400 } },
        opts: { agentId: admitted.agentId, includeGlobal: true },
      },
    );
    expect(result.sessions).toMatchObject([
      { key: requesterKey, agentId: "other", swarm: { groups: [{ done: 1 }] } },
    ]);
  },
);

it("bounds active groups and keeps only the latest completed group", () => {
  const runs = Array.from({ length: 8 }, (_, index) =>
    collector(index, {
      groupId: `group-${index}`,
      ...(index < 6
        ? { collectorCompletion: undefined, execution: { status: "queued" as const } }
        : {}),
    }),
  );
  const summary = summarize(runs, parent, "main");
  expect(summary?.groups.map((group) => group.groupId)).toEqual(
    [5, 4, 3, 2, 7].map((i) => `group-${i}`),
  );
  expect(summary?.otherActiveGroups).toBe(2);
});
it.each(["swarmRequesterSessionKey", "requesterAgentId"] as const)(
  "does not infer missing %s from completion routing",
  (field) => {
    expect(summarize([collector(0, { [field]: undefined })], parent, "main")).toBeUndefined();
  },
);

it.each(["global", "unknown"])(
  "clears computed counts but omits uncomputed and unscoped %s events",
  (key) => {
    const swarm = summarize([collector(0)], parent, "main", { includeChildren: true });
    expect(snapshot()).not.toHaveProperty("swarm");
    expect(snapshot({ swarm: undefined })).toHaveProperty("swarm", null);
    const row = { key, kind: "global" as const, swarm };
    expect(snapshot(row, { agentId: "main" })).toMatchObject({
      swarm: { groups: [{ done: 1, failed: 0 }] },
    });
    expect(snapshot(row)).not.toHaveProperty("swarm");
    const event = snapshot(row, { includeSession: true });
    expect(event).not.toHaveProperty("swarm");
    expect(event.session).not.toHaveProperty("swarm");
  },
);
