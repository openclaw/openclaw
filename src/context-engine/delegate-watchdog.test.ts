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

const { compactEmbeddedAgentSessionOnDemandMock } = vi.hoisted(() => ({
  compactEmbeddedAgentSessionOnDemandMock: vi.fn(),
}));

vi.mock("../agents/embedded-agent-runner/compact.runtime.js", () => ({
  compactEmbeddedAgentSessionOnDemand: compactEmbeddedAgentSessionOnDemandMock,
}));

type CompactParams = Parameters<ContextEngine["compact"]>[0];

const timeoutMs = 60;
const stageMs = 40;
let engineSequence = 0;
let restoreContextEngineRegistry: () => Promise<void> = async () => {};

function wait(ms: number) {
  const elapsed = createDeferred();
  setTimeout(() => elapsed.resolve(), ms);
  return elapsed.promise;
}

beforeAll(() => {
  restoreContextEngineRegistry = captureContextEngineRegistryStateForTests();
});
afterAll(() => restoreContextEngineRegistry());

beforeEach(async () => {
  await registerLegacyContextEngine();
  compactEmbeddedAgentSessionOnDemandMock.mockReset();
  // Native staged compaction: each serial request fits the window; together they exceed it.
  compactEmbeddedAgentSessionOnDemandMock.mockImplementation(
    async (params: { abortSignal?: AbortSignal; compactionTimeoutReset?: () => void }) => {
      for (let stage = 0; stage < 3; stage += 1) {
        params.compactionTimeoutReset?.();
        await wait(stageMs);
        params.abortSignal?.throwIfAborted();
      }
      return {
        ok: true,
        compacted: true,
        result: { tokensBefore: 900_000, tokensAfter: 20_000 },
      };
    },
  );
  vi.useFakeTimers();
});
afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  await resetContextEngineRuntimeQuarantineForTests();
});

async function registerPlugin(compact: ContextEngine["compact"], ownsCompaction = false) {
  engineSequence += 1;
  const engineId = `delegating-plugin-${engineSequence}`;
  await registerContextEngineForOwner(
    engineId,
    () => ({
      info: { id: engineId, name: "Delegating plugin", ownsCompaction },
      ...createPassthroughEngineMethods(),
      compact,
    }),
    "plugin:delegating-plugin",
    { allowSameOwnerRefresh: true },
  );
  return { plugins: { slots: { contextEngine: engineId } } };
}

// A plugin-owned checkpoint runs before delegating, like a memory plugin.
const checkpointThenDelegate =
  (forward: (params: CompactParams) => CompactParams) => async (params: CompactParams) => {
    await wait(10);
    return await delegateCompactionToRuntime(forward(params));
  };

function compactWithHostWatchdog(engine: ContextEngine) {
  return compactContextEngineWithSafetyTimeout(
    engine,
    { sessionId: "s1", sessionKey: "agent:main:s1", force: true },
    timeoutMs,
  );
}

describe("host watchdog for runtime compaction reached through an engine", () => {
  it.each([
    ["the default engine", async () => await resolveContextEngine()],
    [
      "a plugin passing params unchanged",
      async () =>
        await resolveContextEngine(await registerPlugin(checkpointThenDelegate((p) => p))),
    ],
    [
      "a logical-turn plugin spreading params",
      async () =>
        (
          await resolveLogicalTurnContextEngines(
            await registerPlugin(checkpointThenDelegate((p) => ({ ...p }))),
          )
        ).configured.engine,
    ],
    [
      "a quarantined plugin's fallback",
      async () => {
        const engine = await resolveContextEngine(
          await registerPlugin(async () => {
            throw new Error("plugin compaction failed");
          }, true),
        );
        await expect(
          engine.compact({ sessionId: "s1", sessionKey: "agent:main:s1" }),
        ).rejects.toThrow("plugin compaction failed");
        return engine;
      },
    ],
  ] as const)("refreshes per native stage for %s", async (_name, resolveEngine) => {
    const engine = await resolveEngine();
    const pending = compactWithHostWatchdog(engine);
    const settled = expect(pending).resolves.toMatchObject({ ok: true, compacted: true });
    await vi.advanceTimersByTimeAsync(10 + 3 * stageMs);
    await settled;
    expect(compactEmbeddedAgentSessionOnDemandMock).toHaveBeenCalledOnce();
  });

  it("keeps plugin-owned work after the delegate under one host window", async () => {
    let delegated = false;
    const engine = await resolveContextEngine(
      await registerPlugin(async (params) => {
        await delegateCompactionToRuntime(params);
        delegated = true;
        return await createDeferred<never>().promise;
      }),
    );
    const pending = compactWithHostWatchdog(engine);
    const settled = expect(pending).rejects.toThrow("Compaction timed out");
    await vi.advanceTimersByTimeAsync(3 * stageMs);
    expect(delegated).toBe(true);
    await vi.advanceTimersByTimeAsync(timeoutMs);
    await settled;
  });
});
