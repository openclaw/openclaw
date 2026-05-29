import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test, expect, vi } from "vitest";
import { resetSubagentRegistryForTests } from "../agents/subagent-registry.js";
import type { SubagentRunRecord } from "../agents/subagent-registry.types.js";
import * as thinking from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/config.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { resetAgentRunContextForTest } from "../infra/agent-events.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { withEnv } from "../test-utils/env.js";
import * as usageFormat from "../utils/usage-format.js";
import {
  filterAndSortSessionEntries,
  listSessionsFromStore,
  loadGatewaySessionRow,
} from "./session-utils.js";

/**
 * Regression smoke for the per-list rowContext resolver cache. The bug we are
 * guarding against is O(rows) scaling of deterministic resolvers whose results
 * only depend on `(provider, model[, agentId])`: with N sessions sharing K
 * unique model tuples, the cached path must perform at most O(K) underlying
 * resolver calls -- not O(N).
 *
 * We assert call counts directly instead of a wall-time bound because shared
 * CI runners cannot give a stable wall-time signal, and call-count regressions
 * are the actual scaling failure mode we care about.
 */
describe("listSessionsFromStore resolver cache", () => {
  test("collapses non-lightweight per-row resolver work to O(unique provider/model tuples)", async () => {
    await withStateDirEnv("openclaw-perf-", async ({ stateDir }) => {
      resetPluginRuntimeStateForTest();
      setActivePluginRegistry(createEmptyPluginRegistry());
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { model: { primary: "google-vertex/gemini-3-flash-preview" } },
        },
      } as OpenClawConfig;
      resetConfigRuntimeState();
      setRuntimeConfigSnapshot(cfg);

      const tuples: Array<{ modelProvider: string; model: string }> = [
        { modelProvider: "google-vertex", model: "gemini-3-flash-preview" },
        { modelProvider: "openai", model: "gpt-5" },
        { modelProvider: "anthropic", model: "claude-opus-4-7" },
        { modelProvider: "openrouter", model: "z-ai/glm-5" },
        { modelProvider: "google", model: "gemini-2.5-pro" },
      ];

      const store: Record<string, SessionEntry> = {};
      const now = Date.now();
      const rowCount = 30;
      for (let i = 0; i < rowCount; i++) {
        const tuple = tuples[i % tuples.length];
        store[`agent:default:webchat:dm:${i}`] = {
          updatedAt: now - i,
          modelProvider: tuple.modelProvider,
          model: tuple.model,
          inputTokens: 100,
          outputTokens: 50,
        } as SessionEntry;
      }

      const thinkingSpy = vi.spyOn(thinking, "listThinkingLevelOptions");
      const costSpy = vi.spyOn(usageFormat, "resolveModelCostConfig");
      try {
        const result = listSessionsFromStore({
          cfg,
          storePath: path.join(stateDir, "sessions.json"),
          store,
          // sessions.list bounds responses to 100 rows by default; the perf
          // smoke explicitly opts into the full set so the non-lightweight
          // row builder exercises the display-identity, thinking-default, and
          // model-cost caches at scale.
          opts: { limit: rowCount },
        });
        expect(result.sessions.length).toBe(rowCount);

        // The cache keys on rowContext are (provider, model) or
        // (agentId, provider, model). With K=5 unique tuples we must see at
        // most a small constant number of resolver calls, not O(N=30). A
        // pre-cache regression would scale linearly and easily exceed the
        // threshold below.
        const cacheCallCeiling = tuples.length * 4;
        expect(thinkingSpy.mock.calls.length).toBeLessThanOrEqual(cacheCallCeiling);
        expect(costSpy.mock.calls.length).toBeLessThanOrEqual(cacheCallCeiling);
      } finally {
        thinkingSpy.mockRestore();
        costSpy.mockRestore();
      }
    });
  });
});

type SubagentRegistryReadFixture = {
  cfg: OpenClawConfig;
  stateDir: string;
  tempRoot: string;
  storePath: string;
  registryPath: string;
  store: Record<string, SessionEntry>;
  controllerSessionKey: string;
  now: number;
};

const CODECLAW_SHAPED_SESSION_ENTRY_COUNT = 545;
const CODECLAW_SHAPED_SUBAGENT_RUN_COUNT = 555;

function createCodeClawShapedSubagentRegistryReadFixture(): SubagentRegistryReadFixture {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pr1-read-index-"));
  const stateDir = path.join(tempRoot, "state");
  const storePath = path.join(tempRoot, "sessions.json");
  const registryPath = path.join(stateDir, "subagents", "runs.json");
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.mkdirSync(path.dirname(storePath), { recursive: true });

  const now = Date.now();
  const controllerSessionKey = "agent:main:main";
  const movedControllerSessionKey = "agent:main:subagent:moved-controller";
  const store: Record<string, SessionEntry> = {
    [controllerSessionKey]: { sessionId: "sess-main", updatedAt: now } as SessionEntry,
  };
  const runs: Record<string, SubagentRunRecord> = {};

  for (let index = 0; index < CODECLAW_SHAPED_SESSION_ENTRY_COUNT - 1; index += 1) {
    const childSessionKey = `agent:main:subagent:child-${String(index).padStart(4, "0")}`;
    const isStoreOnly = index % 109 === 0;
    const isMovedLatest = index === 7;
    const isMovedAway = index === 8;
    const isRecentlyEnded = index % 5 === 1;
    const isStaleRunning = index % 5 === 2;
    const startedAt = isStaleRunning ? now - 3 * 60 * 60_000 : now - 60_000 - index;
    const endedAt = isRecentlyEnded ? now - 120_000 : undefined;

    store[childSessionKey] = {
      sessionId: `sess-child-${index}`,
      updatedAt: now - index,
      spawnedBy: controllerSessionKey,
      status: isRecentlyEnded ? "done" : "running",
      startedAt,
      ...(endedAt === undefined ? {} : { endedAt, runtimeMs: 60_000 }),
    } as SessionEntry;

    if (isStoreOnly) {
      continue;
    }

    runs[`run-child-${index}`] = {
      runId: `run-child-${index}`,
      childSessionKey,
      controllerSessionKey: isMovedAway ? movedControllerSessionKey : controllerSessionKey,
      requesterSessionKey: isMovedAway ? movedControllerSessionKey : controllerSessionKey,
      requesterDisplayKey: "main",
      task: "CodeClaw-shaped child",
      cleanup: "keep",
      createdAt: now - 10_000 + index,
      startedAt,
      ...(endedAt === undefined ? {} : { endedAt, outcome: { status: "ok" } }),
      model: "openai/gpt-5.5",
    };

    if (isMovedLatest) {
      runs[`run-child-${index}-moved-latest`] = {
        runId: `run-child-${index}-moved-latest`,
        childSessionKey,
        controllerSessionKey: movedControllerSessionKey,
        requesterSessionKey: movedControllerSessionKey,
        requesterDisplayKey: "moved",
        task: "moved child",
        cleanup: "keep",
        createdAt: now + index,
        startedAt: now - 30_000,
        model: "openai/gpt-5.5",
      };
    }
  }

  for (
    let index = Object.keys(runs).length;
    index < CODECLAW_SHAPED_SUBAGENT_RUN_COUNT;
    index += 1
  ) {
    const childSessionKey = `agent:main:subagent:registry-only-${String(index).padStart(4, "0")}`;
    runs[`run-extra-${index}`] = {
      runId: `run-extra-${index}`,
      childSessionKey,
      controllerSessionKey,
      requesterSessionKey: controllerSessionKey,
      requesterDisplayKey: "main",
      task: "registry-only extra",
      cleanup: "keep",
      createdAt: now - 1_000 + index,
      startedAt: now - 500,
      model: "openai/gpt-5.5",
    };
  }

  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
  fs.writeFileSync(registryPath, JSON.stringify({ version: 2, runs }, null, 2), "utf-8");

  const cfg = {
    session: { mainKey: "main", store: storePath },
    agents: { list: [{ id: "main", default: true }] },
  } as OpenClawConfig;

  return { cfg, stateDir, tempRoot, storePath, registryPath, store, controllerSessionKey, now };
}

function countRegistryStatCalls(
  spy: { mock: { calls: readonly (readonly unknown[])[] } },
  registryPath: string,
): number {
  return spy.mock.calls.filter(
    (call) => path.normalize(String(call[0])) === path.normalize(registryPath),
  ).length;
}

function cleanupSubagentRegistryReadFixture(fixture: SubagentRegistryReadFixture): void {
  resetSubagentRegistryForTests({ persist: false });
  resetAgentRunContextForTest();
  resetConfigRuntimeState();
  fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
}

describe("gateway session subagent read index", () => {
  test("loads a full session row with one subagent registry snapshot for the operation", () => {
    const fixture = createCodeClawShapedSubagentRegistryReadFixture();
    setRuntimeConfigSnapshot(fixture.cfg);
    const statSpy = vi.spyOn(fs, "statSync");
    try {
      const row = withEnv(
        {
          OPENCLAW_STATE_DIR: fixture.stateDir,
          OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK: "1",
        },
        () => loadGatewaySessionRow(fixture.controllerSessionKey, { now: fixture.now }),
      );
      const registryStatCalls = countRegistryStatCalls(statSpy, fixture.registryPath);

      expect(row?.childSessions?.length).toBeGreaterThan(100);
      expect(registryStatCalls).toBeLessThanOrEqual(1);
    } finally {
      statSpy.mockRestore();
      cleanupSubagentRegistryReadFixture(fixture);
    }
  });

  test("filters spawned subagent sessions with one registry snapshot when no row context is supplied", () => {
    const fixture = createCodeClawShapedSubagentRegistryReadFixture();
    setRuntimeConfigSnapshot(fixture.cfg);
    const statSpy = vi.spyOn(fs, "statSync");
    try {
      const entries = withEnv(
        {
          OPENCLAW_STATE_DIR: fixture.stateDir,
          OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK: "1",
        },
        () =>
          filterAndSortSessionEntries({
            cfg: fixture.cfg,
            store: fixture.store,
            now: fixture.now,
            opts: {
              spawnedBy: fixture.controllerSessionKey,
              limit: CODECLAW_SHAPED_SESSION_ENTRY_COUNT,
            },
          }),
      );
      const registryStatCalls = countRegistryStatCalls(statSpy, fixture.registryPath);

      expect(entries.length).toBeGreaterThan(100);
      expect(registryStatCalls).toBeLessThanOrEqual(1);
    } finally {
      statSpy.mockRestore();
      cleanupSubagentRegistryReadFixture(fixture);
    }
  });
});
