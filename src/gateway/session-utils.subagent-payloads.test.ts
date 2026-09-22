import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as subagentRegistryState from "../agents/subagents/registry/subagent-registry-state.js";
import {
  canonicalSubagentRunFixtures,
  type SubagentRunFixture,
} from "../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { saveSubagentRegistryToSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { claimAgentRunContext } from "../infra/agent-run-registry.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withStateDirEnv as withRawStateDirEnv } from "../test-helpers/state-dir-env.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createResidentSessionRowReader } from "./session-row-projection.test-support.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";

const rowReader = createResidentSessionRowReader();

async function withStateDirEnv<T>(
  prefix: string,
  fn: (context: { tempRoot: string; stateDir: string }) => Promise<T>,
) {
  return withRawStateDirEnv(prefix, async (context) => {
    try {
      return await fn(context);
    } finally {
      await rowReader.dispose();
    }
  });
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

async function seedSessionEntry(
  storePath: string,
  sessionKey: string,
  entry: SessionEntry,
): Promise<void> {
  await replaceSessionEntry({ sessionKey, storePath }, entry);
}

describe("session list subagent payload reads", () => {
  afterEach(async () => {
    resetAgentEventsForTest({ preserveListeners: true });
    await closeOpenClawStateDatabaseAsync();
    resetSubagentRegistryForTests({ persist: false });
  });
  beforeEach(() => {
    resetAgentEventsForTest({ preserveListeners: true });
    resetSubagentRegistryForTests({ persist: false });
  });

  const cfg: OpenClawConfig = {
    session: { mainKey: "main" },
    agents: { list: [{ id: "main", default: true }] },
  };

  test("loads direct children without repeated or unrelated host-thread payload validation", async () => {
    await withStateDirEnv("openclaw-controller-registry-projection-", async () => {
      await withEnvAsync({ OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" }, async () => {
        const parentKey = "agent:main:main";
        const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
        const runs = new Map<string, SubagentRunFixture>();
        setRuntimeConfigSnapshot(cfg, cfg);
        const nativeJson = new DatabaseSync(":memory:");
        try {
          await seedSessionEntry(storePath, parentKey, { sessionId: "parent", updatedAt: 1 });
          for (const runId of ["explicit", "fallback", "redirected", "unrelated", "alias"]) {
            const childSessionKey = `agent:main:subagent:${runId}`;
            await seedSessionEntry(storePath, childSessionKey, { sessionId: runId, updatedAt: 1 });
            runs.set(runId, {
              runId,
              childSessionKey,
              requesterSessionKey:
                runId === "explicit" || runId === "unrelated"
                  ? "agent:main:other"
                  : runId === "alias"
                    ? "main"
                    : parentKey,
              controllerSessionKey:
                runId === "fallback" || runId === "alias"
                  ? undefined
                  : runId === "explicit"
                    ? parentKey
                    : "agent:main:other",
              requesterDisplayKey: "parent",
              task:
                runId === "unrelated"
                  ? "unrelated-retained-payload".repeat(1_024)
                  : `selected-retained-payload:${runId}:${"x".repeat(16_384)}`,
              cleanup: "keep",
              createdAt: runId === "alias" ? 0 : 1,
              startedAt: 2,
            });
          }
          saveSubagentRegistryToSqlite(canonicalSubagentRunFixtures(runs));
          subagentRegistryState.clearSubagentRunsReadCacheForTest();
          const validateJson = nativeJson.prepare("SELECT json_valid(?) AS value");
          let unrelatedInspections = 0;
          let retainedValidationBytes = 0;
          openOpenClawStateDatabase().db.function(
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
          const { store } = loadGatewaySessionEntryReadOnly("main", {
            includeStoreChildEntries: true,
          });
          expect(Object.keys(store)).toEqual([
            parentKey,
            "agent:main:subagent:explicit",
            "agent:main:subagent:fallback",
            "agent:main:subagent:alias",
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
          resetConfigRuntimeState();
        }
      });
    });
  });

  test("projects lifecycle ownership and lineage without parsing retained task payloads", async () => {
    await withStateDirEnv("openclaw-lifecycle-registry-projection-", async () => {
      await withEnvAsync({ OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" }, async () => {
        const now = Date.now();
        // Stack formatting can parse this test’s source map; only runtime bytes identify stored tasks.
        const retainedTaskMarker = `retained-task-payload:${now}:`;
        const parentKey = "agent:main:main";
        const childKey = "agent:main:subagent:lifecycle-child";
        const navigationKey = "agent:main:dashboard:navigation-parent";
        const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
        setRuntimeConfigSnapshot(cfg, cfg);
        try {
          await seedSessionEntry(storePath, parentKey, { sessionId: "parent", updatedAt: now });
          await seedSessionEntry(storePath, childKey, {
            sessionId: "child",
            updatedAt: now,
            parentSessionKey: navigationKey,
            spawnedBy: "agent:main:subagent:old-controller",
          });
          const runs = new Map<string, SubagentRunFixture>();
          for (let index = 0; index < 20; index += 1) {
            const runId = `retained-${index}`;
            runs.set(runId, {
              runId,
              childSessionKey: `agent:main:subagent:${runId}`,
              requesterSessionKey: parentKey,
              requesterDisplayKey: "main",
              task: `${retainedTaskMarker}${"x".repeat(16_384)}`,
              cleanup: "keep",
              createdAt: now - 10_000,
              startedAt: now - 9_000,
              endedAt: now - 8_000,
              outcome: { status: "ok" },
            });
          }
          saveSubagentRegistryToSqlite(canonicalSubagentRunFixtures(runs));
          addSubagentRunForTests({
            runId: "live-child",
            childSessionKey: childKey,
            controllerSessionKey: parentKey,
            requesterSessionKey: parentKey,
            requesterDisplayKey: "main",
            task: "live child",
            cleanup: "keep",
            createdAt: now - 100,
            startedAt: now - 50,
          });
          claimAgentRunContext(
            "live-child",
            { sessionKey: childKey },
            { trackOwner: true, ownsContext: true },
          );
          subagentRegistryState.clearSubagentRunsReadCacheForTest();
          await (await rowReader.ready()).ensureMaterialized();
          const parse = vi.spyOn(JSON, "parse");
          try {
            const parent = (await rowReader.snapshot(parentKey, { now })).row;
            const child = (await rowReader.snapshot(childKey, { now })).row;
            expect(parent).toMatchObject({ hasActiveSubagentRun: true, childSessions: [childKey] });
            expect(child).toMatchObject({
              subagentRunState: "active",
              hasActiveSubagentRun: true,
              controlOwnerSessionKey: parentKey,
              parentSessionKey: navigationKey,
            });
            expect(parent?.swarm).toBeUndefined();
            expect(child?.swarm).toBeUndefined();
            expect(parse.mock.calls.some(([value]) => value.includes(retainedTaskMarker))).toBe(
              false,
            );
          } finally {
            parse.mockRestore();
          }
        } finally {
          await rowReader.dispose();
          resetConfigRuntimeState();
        }
      });
    });
  });
});
