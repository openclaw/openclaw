import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { compactContextEngineWithSafetyTimeout } from "../agents/embedded-agent-runner/compaction-safety-timeout.js";
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
  resetContextEngineRuntimeQuarantineForTests,
} from "./registry.test-support.js";
import type { ContextEngine } from "./types.js";

const { compactRuntime } = vi.hoisted(() => ({ compactRuntime: vi.fn() }));

vi.mock("../agents/embedded-agent-runner/compact.runtime.js", () => ({
  compactEmbeddedAgentSessionOnDemand: compactRuntime,
}));

type CompactParams = Parameters<ContextEngine["compact"]>[0];

const timeoutMs = 60;
const stageMs = 40;
const session = { sessionId: "s1", sessionKey: "agent:main:s1" };
const forcedSession = { ...session, force: true };
let engineSequence = 0;
let restoreContextEngineRegistry: () => Promise<void> = async () => {};

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

beforeAll(() => {
  restoreContextEngineRegistry = captureContextEngineRegistryStateForTests();
});
afterAll(() => restoreContextEngineRegistry());

beforeEach(async () => {
  await registerLegacyContextEngine();
  compactRuntime.mockReset();
  // Native staged compaction: each serial request fits the window; together they exceed it.
  compactRuntime.mockImplementation(
    async (params: { abortSignal?: AbortSignal; compactionTimeoutReset?: () => void }) => {
      for (let stage = 0; stage < 3; stage += 1) {
        params.compactionTimeoutReset?.();
        await wait(stageMs);
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
  const config = { plugins: { slots: { contextEngine: engineId } } };
  return logicalTurn
    ? (await resolveLogicalTurnContextEngines(config)).configured.engine
    : await resolveContextEngine(config);
}

// A plugin-owned checkpoint runs before delegating, like a memory plugin.
async function checkpointThenDelegate(params: CompactParams) {
  await wait(10);
  return await delegateCompactionToRuntime(params);
}

describe("host watchdog for runtime compaction reached through an engine", () => {
  it.each([
    ["the default engine", async () => await resolveContextEngine()],
    ["a plugin passing params unchanged", () => resolvePlugin(checkpointThenDelegate)],
    [
      "a logical-turn plugin spreading params",
      () => resolvePlugin((p) => checkpointThenDelegate({ ...p }), { logicalTurn: true }),
    ],
    [
      "a quarantined plugin's fallback",
      async () => {
        const engine = await resolvePlugin(
          async () => {
            throw new Error("plugin compaction failed");
          },
          { ownsCompaction: true },
        );
        await expect(engine.compact(session)).rejects.toThrow("plugin compaction failed");
        return engine;
      },
    ],
  ] as const)("refreshes per native stage for %s", async (_name, resolveEngine) => {
    const engine = await resolveEngine();
    const pending = compactContextEngineWithSafetyTimeout(engine, forcedSession, timeoutMs);
    const settled = expect(pending).resolves.toMatchObject({ ok: true, compacted: true });
    await vi.advanceTimersByTimeAsync(10 + 3 * stageMs);
    await settled;
    expect(compactRuntime).toHaveBeenCalledOnce();
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
});
