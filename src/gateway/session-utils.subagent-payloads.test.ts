import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { saveSubagentRegistryToSqlite } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import * as subagentRegistryState from "../agents/subagents/registry/subagent-registry-state.js";
import {
  canonicalSubagentRunFixtures,
  type SubagentRunFixture as Run,
} from "../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { claimAgentRunContext } from "../infra/agent-run-registry.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withStateDirEnv as withRawStateDirEnv } from "../test-helpers/state-dir-env.js";
import { withEnvAsync } from "../test-utils/env.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { createResidentSessionRowReader } from "./session-row-projection.test-support.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";

const rowReader = createResidentSessionRowReader();
const parentKey = "agent:main:main";
const cfg: OpenClawConfig = {
  session: { mainKey: "main" },
  agents: { entries: { main: {} } },
};
const childKey = (runId: string) => `agent:main:subagent:${runId}`;
const makeRun = (runId: string, overrides: Partial<Run> = {}): Run => ({
  runId,
  childSessionKey: childKey(runId),
  requesterSessionKey: parentKey,
  requesterDisplayKey: "main",
  task: "live child",
  cleanup: "keep",
  createdAt: 1,
  startedAt: 2,
  ...overrides,
});
const writeSession = (sessionKey: string, sessionId: string, fields: Partial<SessionEntry> = {}) =>
  replaceSessionEntrySync(
    { storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }), sessionKey },
    { sessionId, updatedAt: 1, ...fields },
  );
const saveRuns = (runs: Run[]) =>
  saveSubagentRegistryToSqlite(
    canonicalSubagentRunFixtures(new Map(runs.map((run) => [run.runId, run]))),
  );

async function withPayloadState(fn: () => Promise<void>) {
  await withRawStateDirEnv("openclaw-registry-projection-", () =>
    withEnvAsync({ OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" }, async () => {
      setRuntimeConfigSnapshot(cfg, cfg);
      try {
        await fn();
      } finally {
        await rowReader.dispose();
        await closeOpenClawStateDatabaseAsync();
        resetConfigRuntimeState();
      }
    }),
  );
}

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  resetAgentEventsForTest({ preserveListeners: true });
  await closeOpenClawStateDatabaseAsync();
  await resetSubagentRegistryForTests({ persist: false });
});
beforeEach(async () => {
  resetAgentEventsForTest({ preserveListeners: true });
  await resetSubagentRegistryForTests({ persist: false });
});

test("loads direct children without repeated or unrelated host-thread payload validation", async () => {
  await withPayloadState(async () => {
    const runs: Run[] = [];
    const nativeJson = new DatabaseSync(":memory:");
    try {
      // Async writes schedule maintenance whose retained-payload reads contaminate this observer.
      writeSession(parentKey, "parent");
      const other = "agent:main:other";
      for (const [runId, requesterSessionKey, controllerSessionKey] of [
        ["explicit", other, parentKey],
        ["fallback", parentKey, undefined],
        ["redirected", parentKey, other],
        ["unrelated", other, other],
        ["alias", "main", undefined],
      ] as const) {
        writeSession(childKey(runId), runId);
        runs.push(
          makeRun(runId, {
            requesterSessionKey,
            controllerSessionKey,
            requesterDisplayKey: "parent",
            task:
              runId === "unrelated"
                ? "unrelated-retained-payload".repeat(1_024)
                : `selected-retained-payload:${runId}:${"x".repeat(16_384)}`,
            createdAt: runId === "alias" ? 0 : 1,
          }),
        );
      }
      saveRuns(runs);
      subagentRegistryState.clearSubagentRunsReadCacheForTest();
      const validateJson = nativeJson.prepare("SELECT json_valid(?) AS value");
      let unrelatedInspections = 0;
      let retainedValidationBytes = 0;
      requireNativeSqliteDatabase(openOpenClawStateDatabase().db).function(
        "json_valid",
        { deterministic: true },
        (value) => {
          if (typeof value === "string" && value.includes("unrelated-retained-payload")) {
            unrelatedInspections += 1;
          }
          if (typeof value === "string" && value.includes("selected-retained-payload:")) {
            retainedValidationBytes += Buffer.byteLength(value);
          }
          return validateJson.get(value)?.value ?? 0;
        },
      );

      await subagentRegistryState.prepareSubagentSessionListReadCache();
      const { store } = await loadGatewaySessionEntryReadOnlyInWorker({
        cfg,
        key: "main",
        includeStoreChildEntries: true,
      });
      expect(Object.keys(store)).toEqual([
        parentKey,
        ...["explicit", "fallback", "alias"].map(childKey),
      ]);
      expect(unrelatedInspections).toBe(0);
      // Host validation stays proportional to selected bytes, not metadata fields per payload.
      const selectedPayloadBytes = openOpenClawStateDatabase()
        .db.prepare(
          "SELECT sum(length(CAST(payload_json AS BLOB))) AS bytes FROM subagent_runs WHERE run_id IN ('explicit', 'fallback', 'alias')",
        )
        .get()?.bytes;
      expect(typeof selectedPayloadBytes).toBe("number");
      expect(retainedValidationBytes).toBeLessThanOrEqual(Number(selectedPayloadBytes) * 2);
      await (await rowReader.ready()).ensureMaterialized();
      const startupInspections = unrelatedInspections;
      expect((await rowReader.row(parentKey))?.key).toBe(parentKey);
      expect(unrelatedInspections).toBe(startupInspections);
    } finally {
      await rowReader.dispose();
      await closeOpenClawStateDatabaseAsync();
      nativeJson.close();
    }
  });
});

test("projects lifecycle ownership and lineage without parsing retained task payloads", async () => {
  await withPayloadState(async () => {
    const now = Date.now();
    // Stack formatting can parse this test’s source map; only runtime bytes identify stored tasks.
    const retainedTaskMarker = `retained-task-payload:${now}:`;
    const liveChildKey = childKey("lifecycle-child");
    const navigationKey = "agent:main:dashboard:navigation-parent";
    writeSession(parentKey, "parent", { updatedAt: now });
    writeSession(liveChildKey, "child", {
      updatedAt: now,
      parentSessionKey: navigationKey,
      spawnedBy: "agent:main:subagent:old-controller",
    });
    saveRuns(
      Array.from({ length: 20 }, (_, index) =>
        makeRun(`retained-${index}`, {
          task: `${retainedTaskMarker}${"x".repeat(16_384)}`,
          createdAt: now - 10_000,
          startedAt: now - 9_000,
          endedAt: now - 8_000,
          outcome: { status: "ok" },
        }),
      ),
    );
    await addSubagentRunForTests(
      makeRun("live-child", {
        childSessionKey: liveChildKey,
        controllerSessionKey: parentKey,
        createdAt: now - 100,
        startedAt: now - 50,
      }),
    );
    claimAgentRunContext(
      "live-child",
      { sessionKey: liveChildKey },
      { trackOwner: true, ownsContext: true },
    );
    subagentRegistryState.clearSubagentRunsReadCacheForTest();
    await (await rowReader.ready()).ensureMaterialized();
    const parse = vi.spyOn(JSON, "parse");
    try {
      const parent = (await rowReader.snapshot(parentKey, { now })).row;
      const child = (await rowReader.snapshot(liveChildKey, { now })).row;
      expect(parent).toMatchObject({
        hasActiveSubagentRun: true,
        childSessions: [liveChildKey],
      });
      expect(child).toMatchObject({
        subagentRunState: "active",
        hasActiveSubagentRun: true,
        controlOwnerSessionKey: parentKey,
        parentSessionKey: navigationKey,
      });
      expect([parent?.swarm, child?.swarm]).toEqual([undefined, undefined]);
      expect(parse.mock.calls.some(([value]) => value.includes(retainedTaskMarker))).toBe(false);
    } finally {
      parse.mockRestore();
    }
  });
});
