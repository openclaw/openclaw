import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createContextEngineLogicalTurnLease as createLease } from "../agents/harness/context-engine-logical-turn.js";
import * as turnAdmission from "../agents/harness/context-engine-turn-attempt.js";
import { beginContextEngineLogicalTurn as beginTurn } from "../agents/harness/context-engine-turn-begin.js";
import { createAgentCleanupScope } from "../agents/run-cleanup-timeout.js";
import { SessionTranscriptReadFenceError } from "../config/sessions/session-transcript-read-fence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearMemoryPluginState,
  registerMemoryPromptPreparation,
  registerTestMemoryPromptBuilder,
} from "../plugins/memory-state.test-fixtures.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  requireActivePluginRegistry,
  setActivePluginRegistry,
  withPluginRegistrationContext,
} from "../plugins/runtime.js";
import { createUserTurnTranscriptRecorder as createRecorder } from "../sessions/user-turn-transcript.js";
import { createPassthroughEngineMethods } from "./context-engine.test-support.js";
import {
  buildMemorySystemPromptAddition,
  delegateCompactionToRuntime,
  prepareMemorySystemPromptAddition,
} from "./delegate.js";
import * as initialization from "./init.js";
import { LegacyContextEngine } from "./legacy.js";
import { registerLegacyContextEngine } from "./legacy.registration.js";
import {
  activateContextEngineRegistrations,
  getContextEngineRegistration,
  listContextEngineQuarantines as quarantines,
  registerContextEngineForOwner as register,
  registerContextEngineInRegistry as registerIn,
  resolveContextEngine as resolve,
  resolveContextEngineOwnerPluginId as ownerOf,
  resolveLogicalTurnContextEngines as resolveTurn,
} from "./registry.js";
import {
  captureContextEngineRegistryStateForTests,
  resetContextEngineRuntimeQuarantineForTests,
} from "./registry.test-support.js";
import type { ContextEngine, ContextEngineHostCapability } from "./types.js";

const { compactRuntime } = vi.hoisted(() => ({ compactRuntime: vi.fn() }));
// mock-isolation: observe delegation without starting a provider-backed runner.
vi.mock("../agents/embedded-agent-runner/compact.runtime.js", () => ({
  compactEmbeddedAgentSessionOnDemand: compactRuntime,
}));

const session = { sessionId: "session", sessionKey: "agent:main:session" };
const target = { agentId: "main", ...session };
const host = { id: "agent-harness:test", label: "test harness", capabilities: [] };
const refresh = { allowSameOwnerRefresh: true };
const identity = { runId: "test-run", sessionId: "test-session" };
const message = (content = "hello"): AgentMessage => ({ role: "user", content, timestamp: 1 });
const makeEngine = (id: string): ContextEngine => ({
  info: { id, name: id },
  ...createPassthroughEngineMethods(),
});
let sequence = 0;
let id: string;
let raw: ContextEngine;
const owned = new Set<ContextEngine>();
const config = (engineId = id): OpenClawConfig => ({
  plugins: { slots: { contextEngine: engineId }, allow: ["fixture"] },
});
const engine = () => resolve(config());
const lease = (engineId = id) => createLease({ identity, config: config(engineId) });
const resolvedId = async (engineId = id) => (await resolve(config(engineId))).info.id;
const expectQuarantine = (operation: string, reason?: string, engineId = id) =>
  expect(quarantines()).resolves.toEqual([
    expect.objectContaining({ engineId, operation, ...(reason ? { reason } : {}) }),
  ]);

beforeAll(captureContextEngineRegistryStateForTests);
beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  compactRuntime.mockReset();
  clearMemoryPluginState();
  await resetContextEngineRuntimeQuarantineForTests();
  await registerLegacyContextEngine();
  id = `context-engine-${++sequence}`;
  raw = makeEngine(id);
  const current = raw;
  await register(id, () => current, "plugin:fixture", refresh);
});
afterEach(async () => {
  await Promise.allSettled([...owned].map(async (value) => await value.dispose?.()));
  owned.clear();
  vi.restoreAllMocks();
  clearMemoryPluginState();
});

async function delegated(acceptSessionKey: boolean) {
  raw.info.acceptedHostParams = [
    "runtimeContext",
    "sessionTarget",
    ...(acceptSessionKey ? ["sessionKey"] : []),
  ];
  raw.compact = delegateCompactionToRuntime;
  const turn = await resolveTurn(config());
  owned.add(turn.configured.engine);
  owned.add(turn.fallback.engine);
  return turn.configured.engine;
}

function fenced(declaresFence = true) {
  raw.info.transcriptSemantics = {
    ...(declaresFence ? { currentTurnFence: "before-current-turn-entry-v1" as const } : {}),
    turnAdvancementIdempotency: "atomic-idempotent-v1",
  };
  raw.commitTurn = async () => ({ status: "committed" });
}

async function expectFallback(value: ContextEngine, operation: string, reason: string) {
  expect(value.info.id).toBe("legacy");
  expect(value.info.ownsCompaction).toBeUndefined();
  expect(ownerOf(value)).toBeUndefined();
  expect(await resolvedId()).toBe("legacy");
  await expectQuarantine(operation, reason);
}

it("delegates compaction with caller identity overriding runtime context", async () => {
  const sessionTarget = { ...target, storePath: "/tmp/openclaw-agent.sqlite" };
  const result = {
    ok: true,
    compacted: false,
    reason: "mock compaction",
    result: {
      summary: "retained summary",
      sessionTarget,
    },
  };
  compactRuntime.mockResolvedValue(result);
  const runtimeContext = {
    workspaceDir: "/tmp/workspace",
    currentTokenCount: 12345,
    agentId: "ignored",
    sessionKey: "agent:ignored:ignored",
    sessionTarget: { agentId: "ignored" },
  };
  const abortSignal = new AbortController().signal;
  await expect(
    delegateCompactionToRuntime({
      ...target,
      sessionTarget,
      tokenBudget: 4096,
      runtimeContext,
      abortSignal,
    }),
  ).resolves.toEqual(result);
  const params = compactRuntime.mock.calls[0]?.[0];
  expect(params).toMatchObject({
    ...target,
    sessionTarget,
    tokenBudget: 4096,
    abortSignal,
    currentTokenCount: 12345,
    workspaceDir: "/tmp/workspace",
  });
  expect(params).not.toHaveProperty("sessionFile");
  expect(params.contextEngineRuntimeContext).toBe(runtimeContext);
});

it.each([
  { name: "caller agent", agentId: "worker" },
  { name: "physical session", sessionId: "another-session" },
  { name: "caller key", sessionKey: "agent:main:another-key" },
  {
    name: "caller parsed key",
    agentId: undefined,
    sessionTarget: { ...target, agentId: "worker" },
  },
  {
    name: "target-only parsed key",
    agentId: undefined,
    projectSessionKey: true,
    sessionTarget: { agentId: "worker", sessionKey: session.sessionKey },
  },
])(
  "rejects $name before the backend runs",
  async ({ name: _name, projectSessionKey, ...input }) => {
    compactRuntime.mockResolvedValue({ ok: true, compacted: true });
    const value = await delegated(!projectSessionKey);
    await expect(value.compact({ ...target, sessionTarget: target, ...input })).rejects.toThrow(
      projectSessionKey
        ? "successor session key conflicts with its agent identity"
        : "successor target conflicts with the caller session identity",
    );
    expect(compactRuntime).not.toHaveBeenCalled();
  },
);

it("normalizes runtime identity after host projection omits the caller key", async () => {
  const sessionTarget = {
    agentId: " main ",
    sessionId: " session ",
    sessionKey: " agent:main:session ",
  };
  const runtimeContext = { ...target, sessionId: "ignored", sessionTarget };
  compactRuntime.mockResolvedValue({ ok: true, compacted: true });
  const compact = vi.fn<ContextEngine["compact"]>(delegateCompactionToRuntime);
  const value = await delegated(false);
  raw.compact = compact;
  await expect(value.compact({ ...session, runtimeContext })).resolves.toEqual({
    ok: true,
    compacted: true,
    reason: undefined,
    result: undefined,
  });
  expect(compact.mock.calls[0]?.[0]).not.toHaveProperty("sessionKey");
  expect(compactRuntime.mock.calls[0]?.[0]).toMatchObject({ ...target, sessionTarget });
  expect(compactRuntime.mock.calls[0]?.[0].contextEngineRuntimeContext).toBe(runtimeContext);
});

const promptContext = {
  availableTools: new Set(["memory_search", "memory_get"]),
  agentId: "main",
  agentSessionKey: "agent:main:main",
  sandboxed: true,
};
it("passes agent context through delegated memory prompt assembly", () => {
  registerTestMemoryPromptBuilder(({ agentId, agentSessionKey, sandboxed }) => [
    `${agentId}:${agentSessionKey}:${sandboxed}`,
    "",
  ]);
  expect(buildMemorySystemPromptAddition(promptContext)).toBe("main:agent:main:main:true");
});
it("returns undefined when memory contributes nothing", () => {
  expect(buildMemorySystemPromptAddition(promptContext)).toBeUndefined();
});
it("prepares async memory state before rendering", async () => {
  registerMemoryPromptPreparation("memory-wiki", async () => ["prepared memory", ""]);
  await expect(prepareMemorySystemPromptAddition(promptContext)).resolves.toBe("prepared memory");
});

it("rejects a different registration owner without replacing the factory", async () => {
  const original = getContextEngineRegistration(id)?.factory;
  expect(await register(id, () => makeEngine(id), "plugin:other")).toEqual({
    ok: false,
    existingOwner: "plugin:fixture",
  });
  expect(getContextEngineRegistration(id)?.factory).toBe(original);
});
it("reserves the default engine id in an empty builder", () => {
  const builder = createEmptyPluginRegistry();
  expect(registerIn(builder, "legacy", () => raw, "plugin:shadow")).toEqual({
    ok: false,
    existingOwner: "core",
  });
  expect(builder.contextEngines.size).toBe(0);
});

it("keeps repeated baseline transcript-host selection stable after start", async () => {
  using warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const value = await lease("legacy");
  const recorder = createRecorder({ target: () => undefined });
  recorder.markRuntimePersisted();
  const selection = { lease: value, host, recorder };
  const first = await beginTurn(selection);
  const second = await beginTurn(selection);
  expect(second).toMatchObject({ registeredId: "legacy", mode: "configured" });
  expect(second.engine).toBe(first.engine);
  expect(warn).not.toHaveBeenCalled();
  await value.dispose();
});

it("disposes once after retained turn work rejects", async () => {
  const hold = createDeferred();
  const disposed = createDeferred();
  const dispose = vi.fn(async () => {
    disposed.resolve();
  });
  raw.dispose = dispose;
  const value = await lease();
  value.deferDisposalUntil(hold.promise);
  await value.dispose();
  await value.dispose();
  expect(dispose).not.toHaveBeenCalled();
  expect(() => value.begin()).toThrow("already disposed");
  hold.reject(new Error("pending turn work failed"));
  await disposed.promise;
  await value.dispose();
  expect(dispose).toHaveBeenCalledOnce();
});

it("bounds configured and fallback disposal in parallel", async () => {
  const gate = createDeferred();
  const configuredDispose = vi.fn(() => gate.promise);
  const fallbackDispose = vi.fn(() => gate.promise);
  raw.dispose = configuredDispose;
  const fallback = { ...makeEngine("legacy"), dispose: fallbackDispose };
  await register("legacy", () => fallback, "core", refresh);
  vi.spyOn(initialization, "ensureContextEnginesInitialized").mockResolvedValue(undefined);
  vi.stubEnv("OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS", "25");
  const scope = createAgentCleanupScope();
  const value = await lease();
  vi.useFakeTimers();
  let settled = false;
  const cleanup = scope
    .run(() => value.dispose())
    .then(() => {
      settled = true;
    });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(configuredDispose).toHaveBeenCalledOnce();
    expect(fallbackDispose).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(24);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(scope.outcome).toBe("uncertain");
    await value.dispose();
    expect(configuredDispose).toHaveBeenCalledOnce();
    expect(fallbackDispose).toHaveBeenCalledOnce();
  } finally {
    gate.resolve();
    await cleanup;
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});

it.each([
  ["missing", "not registered"],
  ["discovery", "available for discovery only"],
  ["factory", "factory unavailable"],
] as const)("degrades and warns for %s resolution", async (failure, reason) => {
  const selected = `${id}-${failure}`;
  if (failure !== "missing") {
    registerIn(
      requireActivePluginRegistry(),
      selected,
      () => {
        if (failure === "factory") {
          throw new Error("factory unavailable");
        }
        return raw;
      },
      "plugin:fixture",
      { lifecycle: failure === "discovery" ? "readOnlyDiscovery" : "runtime" },
    );
  }
  using warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const value = await lease(selected);
  expect(value.effectiveEngineId).toBe("legacy");
  expect(value.degraded).toBe(true);
  expect(value.degradedReason).toContain(reason);
  expect(warn).toHaveBeenCalledOnce();
  await value.dispose();
});

it("does not replay a started operation and retries the configured engine next turn", async () => {
  const assemble = vi
    .fn<ContextEngine["assemble"]>()
    .mockRejectedValueOnce(new Error("configured engine unavailable"))
    .mockImplementation(async ({ messages }) => ({ messages, estimatedTokens: 0 }));
  raw.assemble = assemble;
  using warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const first = await lease();
  const params = { ...session, messages: [message()] };
  first.begin();
  await expect(first.engine.assemble(params)).rejects.toThrow("configured engine unavailable");
  expect(first.engine.info.id).toBe(id);
  expect(assemble).toHaveBeenCalledTimes(1);
  expect(warn).not.toHaveBeenCalled();
  await first.dispose();
  const second = await lease();
  await expect(second.engine.assemble(params)).resolves.toMatchObject({
    messages: params.messages,
  });
  expect(second.engine.info.id).toBe(id);
  expect(assemble).toHaveBeenCalledTimes(2);
  await second.dispose();
});

it("rejects an incompatible host after the logical turn starts", async () => {
  fenced();
  raw.info.hostRequirements = {
    "agent-run": { requiredCapabilities: ["thread-bootstrap-projection"] },
  };
  const value = await lease();
  const select = (capabilities: ContextEngineHostCapability[]) =>
    value.selectForHost({
      host: { ...host, id: capabilities.length ? "first" : "fallback", capabilities },
      operation: "agent-run",
      requiresDurableCommit: true,
    });
  select(["thread-bootstrap-projection"]);
  value.begin();
  expect(() => select([])).toThrow(
    'context-engine logical turn cannot change to incompatible test harness: host "fallback" is missing thread-bootstrap-projection',
  );
  expect(value.engine.info.id).toBe(id);
  await value.dispose();
});

it.each([
  [true, true, "legacy", "current-turn transcript admission receipt is unavailable"],
  [false, true, "configured", undefined],
  [false, false, "legacy", "current-turn transcript fencing is not declared"],
] as const)(
  "selects %s persisted / %s fenced turn as %s",
  async (persisted, declaresFence, expected, reason) => {
    fenced(declaresFence);
    using warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const value = await lease();
    const recorder = createRecorder({ target: () => undefined });
    if (persisted) {
      recorder.markRuntimePersisted();
    }
    vi.spyOn(turnAdmission, "drainPendingContextEngineTurnsBeforeRun").mockResolvedValue(undefined);
    const selected = await beginTurn({ lease: value, host, recorder });
    expect(selected.engine.info.id).toBe(expected === "configured" ? id : "legacy");
    expect(value.degradedReason).toBe(reason);
    if (reason) {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(reason));
    } else {
      expect(warn).not.toHaveBeenCalled();
    }
    await value.dispose();
  },
);

it("does not construct or quarantine discovery factories or replace runtime registrations", async () => {
  const selected = `${id}-discovery`;
  using warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const readOnly = vi.fn(() => {
    throw new Error("discovery factory must not run");
  });
  const discover = () =>
    registerIn(requireActivePluginRegistry(), selected, readOnly, "plugin:fixture", {
      ...refresh,
      lifecycle: "readOnlyDiscovery",
    });
  discover();
  expect(await resolvedId(selected)).toBe("legacy");
  expect(readOnly).not.toHaveBeenCalled();
  expect(await quarantines()).toEqual([]);
  expect(warn).toHaveBeenCalledOnce();
  await register(selected, () => raw, "plugin:fixture", refresh);
  expect(await resolvedId(selected)).toBe(id);
  expect(await quarantines()).toEqual([]);
  discover();
  expect(await resolvedId(selected)).toBe(id);
  expect(readOnly).not.toHaveBeenCalled();
});

const invalid = "contract-validation";
it.each<[Parameters<typeof register>[1], string, RegExp]>([
  [() => createPassthroughEngineMethods() as ContextEngine, invalid, /missing info/],
  [
    () =>
      ({
        info: raw.info,
        ingest: (params: Parameters<ContextEngine["ingest"]>[0]) => raw.ingest(params),
      }) as unknown as ContextEngine,
    invalid,
    /missing assemble\(\), missing compact\(\)/,
  ],
  [() => 42n as unknown as ContextEngine, invalid, /BigInt/],
])("falls back for %s failures (%s, %s)", async (factory, operation, reason) => {
  await register(id, factory, "plugin:fixture", refresh);
  expect(await resolvedId()).toBe("legacy");
  await expectQuarantine(operation, expect.stringMatching(reason));
});

it("coalesces fallback initialization across concurrent lifecycle failures", async () => {
  const fallback = vi.fn(async () => new LegacyContextEngine());
  await register("legacy", fallback, "core", refresh);
  const assemble = vi.fn(async () => {
    await Promise.resolve();
    throw new Error("plugin context unavailable");
  });
  raw.assemble = assemble;
  const value = await engine();
  const messages = [message("first"), message("second")];
  const results = await Promise.all(
    messages.map((item) => value.assemble({ ...session, messages: [item] })),
  );
  expect(results.map((result) => result.messages)).toEqual(messages.map((item) => [item]));
  expect(assemble).toHaveBeenCalledTimes(2);
  expect(fallback).toHaveBeenCalledOnce();
  await expectQuarantine("assemble");
});

it("routes fence failures through quarantine and revokes the old owner's hooks", async () => {
  const reason = "admitted user row is unavailable";
  raw.info.ownsCompaction = true;
  const ingest = vi.spyOn(raw, "ingest");
  const assemble = vi
    .fn<() => Promise<never>>()
    .mockRejectedValue(new SessionTranscriptReadFenceError(reason));
  Object.assign(raw, { ingest, assemble });
  const value = await engine();
  expect(value.info.ownsCompaction).toBe(true);
  expect(ownerOf(value)).toBe("fixture");
  for (const item of [message("first"), message("second")]) {
    await expect(value.assemble({ ...session, messages: [item] })).resolves.toMatchObject({
      messages: [item],
    });
  }
  await value.ingest({ ...session, message: message("second") });
  await expectFallback(value, "assemble", reason);
  expect(assemble).toHaveBeenCalledOnce();
  expect(ingest).not.toHaveBeenCalled();
});

it.each(["compact", "prepareSubagentSpawn"] as const)(
  "quarantines %s without replaying it",
  async (method) => {
    const failure = new Error("plugin operation failed");
    const action = vi.fn<() => Promise<never>>().mockRejectedValue(failure);
    raw.info.ownsCompaction = true;
    raw[method] = action;
    const value = await engine();
    const pending =
      method === "compact"
        ? value.compact(session)
        : value.prepareSubagentSpawn?.({
            parentSessionKey: "agent:main",
            childSessionKey: "agent:child",
            contextMode: "isolated",
          });
    await expect(pending).rejects.toBe(failure);
    await expectFallback(value, method, failure.message);
    expect(action).toHaveBeenCalledOnce();
  },
);

it("clears a missing-engine quarantine on later registration", async () => {
  const selected = `${id}-late`;
  expect(await resolvedId(selected)).toBe("legacy");
  await expectQuarantine("resolve", "not registered", selected);
  await register(selected, () => raw, "plugin:fixture", refresh);
  expect(await quarantines()).toEqual([]);
  expect(await resolvedId(selected)).toBe(id);
});

it("does not quarantine a cancelled compaction", async () => {
  const controller = new AbortController();
  const reason = new Error("user stopped compaction");
  const error = new Error("compaction aborted", { cause: reason });
  error.name = "AbortError";
  raw.compact = async () => {
    controller.abort(reason);
    throw error;
  };
  const value = await engine();
  await expect(value.compact({ ...session, abortSignal: controller.signal })).rejects.toBe(error);
  expect(await resolvedId()).toBe(id);
  expect(await quarantines()).toEqual([]);
});

it("defers quarantine clearing until a builder registration is activated", async () => {
  const selected = `${id}-builder`;
  await resolve(config(selected));
  const builder = createEmptyPluginRegistry();
  await withPluginRegistrationContext(builder, "context-builder", () =>
    register(selected, () => raw, "plugin:context-builder", refresh),
  );
  expect(builder.contextEngines.has(selected)).toBe(true);
  expect(getContextEngineRegistration(selected)).toBeUndefined();
  await expectQuarantine("resolve", "not registered", selected);
  setActivePluginRegistry(builder);
  await activateContextEngineRegistrations(builder);
  expect(await quarantines()).toEqual([]);
});

it.each(["before", "during", "never"] as const)(
  "handles maintenance failure when abort is %s",
  async (abortAt) => {
    const controller = new AbortController();
    const reason = new Error("gateway shutdown");
    const abortError = new Error("This operation was aborted");
    abortError.name = "AbortError";
    const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async ({ abortSignal }) => {
      expect(abortSignal).toBe(controller.signal);
      if (abortAt === "during") {
        controller.abort(reason);
      }
      throw abortError;
    });
    raw.maintain = maintain;
    if (abortAt === "before") {
      controller.abort(reason);
    }
    const value = await engine();
    const pending = value.maintain?.({
      ...session,
      sessionFile: "/tmp/s1.jsonl",
      abortSignal: controller.signal,
    });
    if (abortAt === "never") {
      await expect(pending).resolves.toMatchObject({ changed: false });
      expect(controller.signal.aborted).toBe(false);
      expect(await resolvedId()).toBe("legacy");
      await expectQuarantine("maintain", abortError.message);
    } else {
      await expect(pending).rejects.toBe(abortAt === "before" ? reason : abortError);
      expect(await resolvedId()).toBe(id);
      expect(await quarantines()).toEqual([]);
    }
    expect(maintain).toHaveBeenCalledTimes(abortAt === "before" ? 0 : 1);
  },
);

it("throws when the default engine is not registered", async () => {
  const engines = requireActivePluginRegistry().contextEngines;
  const restore = captureContextEngineRegistryStateForTests();
  engines.clear();
  try {
    await expect(resolve()).rejects.toThrow("not registered");
  } finally {
    await restore();
  }
});
it("propagates default-engine contract validation errors", async () => {
  await register("legacy", () => ({ broken: true }) as unknown as ContextEngine, "core", refresh);
  await expect(resolve()).rejects.toThrow(
    'Context engine "legacy" factory returned an invalid ContextEngine',
  );
});

it("shares registrations across bundle chunks and concurrent registration (#40096)", async () => {
  const url = new URL("./registry.ts", import.meta.url).href;
  const other = await import(/* @vite-ignore */ `${url}?chunk=${id}`);
  const factory = () => raw;
  const selected = `${id}-cross-chunk`;
  await register(selected, factory, "plugin:fixture");
  expect(other.getContextEngineRegistration(selected)?.factory).toBe(factory);
  expect((await other.resolveContextEngine(config(selected))).info.id).toBe(id);
  const chunks = [register, other.registerContextEngineForOwner];
  await Promise.all(
    chunks.map((registerChunk, index) =>
      registerChunk(`${id}-concurrent-${index}`, factory, "plugin:fixture"),
    ),
  );
  for (const index of [0, 1]) {
    expect(getContextEngineRegistration(`${id}-concurrent-${index}`)).toBeDefined();
  }
});
