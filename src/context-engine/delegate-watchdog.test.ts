import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { compactContextEngineWithSafetyTimeout } from "../agents/embedded-agent-runner/compaction-safety-timeout.js";
import { sleep } from "../utils/sleep.js";
import { createPassthroughEngineMethods } from "./context-engine.test-support.js";
import { delegateCompactionToRuntime } from "./delegate.js";
import { registerLegacyContextEngine } from "./legacy.registration.js";
import * as registry from "./registry.js";
import * as fixtures from "./registry.test-support.js";
import type { ContextEngine } from "./types.js";

type StageParams = { abortSignal?: AbortSignal; compactionTimeoutReset?: () => void };
const { compactEmbeddedAgentSessionOnDemandMock } = vi.hoisted(() => ({
  compactEmbeddedAgentSessionOnDemandMock: vi.fn(),
}));

vi.mock("../agents/embedded-agent-runner/compact.runtime.js", () => ({
  compactEmbeddedAgentSessionOnDemand: compactEmbeddedAgentSessionOnDemandMock,
}));

const timeoutMs = 60;
const stageMs = 40; // Each native stage fits the window; their total exceeds it.
const session = { sessionId: "s1", sessionKey: "agent:main:s1", force: true };
let engineSequence = 0;

beforeAll(() => fixtures.captureContextEngineRegistryStateForTests());

beforeEach(async () => {
  await registerLegacyContextEngine();
  compactEmbeddedAgentSessionOnDemandMock.mockReset();
  compactEmbeddedAgentSessionOnDemandMock.mockImplementation(async (params: StageParams) => {
    for (let stage = 0; stage < 3; stage += 1) {
      params.compactionTimeoutReset?.();
      await sleep(stageMs);
      params.abortSignal?.throwIfAborted();
    }
    return { ok: true, compacted: true };
  });
  vi.useFakeTimers();
});
afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  await fixtures.resetContextEngineRuntimeQuarantineForTests();
});

async function resolveEngine(
  mode: string,
  compact: ContextEngine["compact"] = async (params) => {
    if (mode === "quarantined") {
      throw new Error("plugin compaction failed");
    }
    await sleep(10);
    return delegateCompactionToRuntime(mode === "logical-turn" ? { ...params } : params);
  },
) {
  if (mode === "default") {
    return registry.resolveContextEngine();
  }
  const engineId = `delegating-plugin-${++engineSequence}`;
  const raw: ContextEngine = {
    info: { id: engineId, name: "Delegating plugin", ownsCompaction: mode === "quarantined" },
    ...createPassthroughEngineMethods(),
    compact,
  };
  await registry.registerContextEngineForOwner(engineId, () => raw, "plugin:delegating-plugin");
  const config = fixtures.contextEngineConfig(engineId, "delegating-plugin");
  const engine =
    mode === "logical-turn"
      ? (await registry.resolveLogicalTurnContextEngines(config)).configured.engine
      : await registry.resolveContextEngine(config);
  if (mode === "quarantined") {
    await expect(engine.compact(session)).rejects.toThrow("plugin compaction failed");
  }
  return engine;
}

const engineModes = ["default", "plugin", "logical-turn", "quarantined"];
it.each(engineModes)("refreshes the watchdog per native stage for %s", async (mode) => {
  const engine = await resolveEngine(mode);
  const pending = compactContextEngineWithSafetyTimeout(engine, session, timeoutMs);
  const settled = expect(pending).resolves.toMatchObject({ ok: true, compacted: true });
  await vi.advanceTimersByTimeAsync(10 + 3 * stageMs);
  await settled;
});

it("keeps plugin-owned work after the delegate under one host window", async () => {
  let delegated = false;
  const engine = await resolveEngine("plugin", async (params) => {
    await delegateCompactionToRuntime(params);
    delegated = true;
    return await createDeferred<never>().promise;
  });
  const pending = compactContextEngineWithSafetyTimeout(engine, session, timeoutMs);
  const settled = expect(pending).rejects.toThrow("Compaction timed out");
  await vi.advanceTimersByTimeAsync(3 * stageMs);
  expect(delegated).toBe(true);
  await vi.advanceTimersByTimeAsync(timeoutMs);
  await settled;
});
