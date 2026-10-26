import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { compactContextEngineWithSafetyTimeout } from "../agents/embedded-agent-runner/compaction-safety-timeout.js";
import { sleep } from "../utils/sleep.js";
import { createPassthroughEngineMethods } from "./context-engine.test-support.js";
import { delegateCompactionToRuntime } from "./delegate.js";
import { registerLegacyContextEngine } from "./legacy.registration.js";
import {
  registerContextEngineForOwner,
  resolveContextEngine,
  resolveLogicalTurnContextEngines,
} from "./registry.js";
import {
  captureContextEngineRegistryStateForTests,
  contextEngineConfig,
  resetContextEngineRuntimeQuarantineForTests,
} from "./registry.test-support.js";
import type { ContextEngine } from "./types.js";

const { compactEmbeddedAgentSessionOnDemandMock } = vi.hoisted(() => ({
  compactEmbeddedAgentSessionOnDemandMock: vi.fn(),
}));

vi.mock("../agents/embedded-agent-runner/compact.runtime.js", () => ({
  compactEmbeddedAgentSessionOnDemand: compactEmbeddedAgentSessionOnDemandMock,
}));

const timeoutMs = 60;
const stageMs = 40;
const session = { sessionId: "s1", sessionKey: "agent:main:s1" };
const forcedSession = { ...session, force: true };
let engineSequence = 0;

beforeAll(() => captureContextEngineRegistryStateForTests());

beforeEach(async () => {
  await registerLegacyContextEngine();
  compactEmbeddedAgentSessionOnDemandMock.mockReset();
  // Native staged compaction: each serial request fits the window; together they exceed it.
  compactEmbeddedAgentSessionOnDemandMock.mockImplementation(
    async (params: { abortSignal?: AbortSignal; compactionTimeoutReset?: () => void }) => {
      for (let stage = 0; stage < 3; stage += 1) {
        params.compactionTimeoutReset?.();
        await sleep(stageMs);
        params.abortSignal?.throwIfAborted();
      }
      return { ok: true, compacted: true };
    },
  );
  vi.useFakeTimers();
});
afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  await resetContextEngineRuntimeQuarantineForTests();
});

async function resolvePlugin(
  compact: ContextEngine["compact"],
  { ownsCompaction = false, logicalTurn = false } = {},
) {
  const engineId = `delegating-plugin-${++engineSequence}`;
  const createEngine = (): ContextEngine => ({
    info: { id: engineId, name: "Delegating plugin", ownsCompaction },
    ...createPassthroughEngineMethods(),
    compact,
  });
  await registerContextEngineForOwner(engineId, createEngine, "plugin:delegating-plugin", {
    allowSameOwnerRefresh: true,
  });
  const config = contextEngineConfig(engineId, "delegating-plugin");
  return logicalTurn
    ? (await resolveLogicalTurnContextEngines(config)).configured.engine
    : await resolveContextEngine(config);
}

async function checkpointThenDelegate(params: Parameters<ContextEngine["compact"]>[0]) {
  await sleep(10);
  return await delegateCompactionToRuntime(params);
}

it.each(
  Object.entries({
    "the default engine": () => resolveContextEngine(),
    "a plugin passing params unchanged": () => resolvePlugin(checkpointThenDelegate),
    "a logical-turn plugin spreading params": () =>
      resolvePlugin((p) => checkpointThenDelegate({ ...p }), { logicalTurn: true }),
    "a quarantined plugin's fallback": async () => {
      const engine = await resolvePlugin(
        () => Promise.reject(new Error("plugin compaction failed")),
        { ownsCompaction: true },
      );
      await expect(engine.compact(session)).rejects.toThrow("plugin compaction failed");
      return engine;
    },
  }),
)("refreshes the host watchdog per native stage for %s", async (_name, resolveEngine) => {
  const engine = await resolveEngine();
  const pending = compactContextEngineWithSafetyTimeout(engine, forcedSession, timeoutMs);
  const settled = expect(pending).resolves.toMatchObject({ ok: true, compacted: true });
  await vi.advanceTimersByTimeAsync(10 + 3 * stageMs);
  await settled;
  expect(compactEmbeddedAgentSessionOnDemandMock).toHaveBeenCalledOnce();
});

it("keeps plugin-owned work after the delegate under one host window", async () => {
  let delegated = false;
  const engine = await resolvePlugin(async (params) => {
    await delegateCompactionToRuntime(params);
    delegated = true;
    return await createDeferred<never>().promise;
  });
  const pending = compactContextEngineWithSafetyTimeout(engine, forcedSession, timeoutMs);
  const settled = expect(pending).rejects.toThrow("Compaction timed out");
  await vi.advanceTimersByTimeAsync(3 * stageMs);
  expect(delegated).toBe(true);
  await vi.advanceTimersByTimeAsync(timeoutMs);
  await settled;
});
