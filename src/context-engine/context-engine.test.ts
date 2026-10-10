import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createContextEngineLogicalTurnLease } from "../agents/harness/context-engine-logical-turn.js";
import * as turnAdmission from "../agents/harness/context-engine-turn-attempt.js";
import { beginContextEngineLogicalTurn } from "../agents/harness/context-engine-turn-begin.js";
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
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import {
  createPassthroughEngineMethods,
  MockContextEngine,
} from "./context-engine.test-support.js";
import {
  buildMemorySystemPromptAddition,
  delegateCompactionToRuntime,
  prepareMemorySystemPromptAddition,
} from "./delegate.js";
import { LegacyContextEngine } from "./legacy.js";
import { registerLegacyContextEngine } from "./legacy.registration.js";
import {
  activateContextEngineRegistrations,
  getContextEngineRegistration,
  listContextEngineQuarantines,
  registerContextEngineForOwner,
  registerContextEngineInRegistry,
  resolveContextEngine,
  resolveContextEngineOwnerPluginId,
  resolveLogicalTurnContextEngines,
} from "./registry.js";
import {
  captureContextEngineRegistryStateForTests,
  resetContextEngineRuntimeQuarantineForTests,
} from "./registry.test-support.js";
import type { ContextEngine, ContextEngineSessionTarget } from "./types.js";

type ContextEngineFactory = Parameters<typeof registerContextEngineForOwner>[1];

function registerTestContextEngine(id: string, factory: ContextEngineFactory) {
  return registerContextEngineForOwner(id, factory, `test:${id}`, {
    allowSameOwnerRefresh: true,
  });
}

const { compactEmbeddedAgentSessionOnDemandMock } = vi.hoisted(() => ({
  compactEmbeddedAgentSessionOnDemandMock: vi.fn(),
}));

vi.mock("../agents/embedded-agent-runner/compact.runtime.js", () => ({
  compactEmbeddedAgentSessionOnDemand: compactEmbeddedAgentSessionOnDemandMock,
}));

function installCompactRuntimeSpy(sessionTarget?: ContextEngineSessionTarget) {
  return compactEmbeddedAgentSessionOnDemandMock.mockResolvedValue({
    ok: true,
    compacted: false,
    reason: "mock compaction",
    result: {
      summary: "",
      firstKeptEntryId: "",
      tokensBefore: 0,
      tokensAfter: 0,
      details: undefined,
      ...(sessionTarget ? { sessionTarget } : {}),
    },
  });
}

function requireCompactRuntimeParams(callIndex: number): Record<string, unknown> {
  const params = compactEmbeddedAgentSessionOnDemandMock.mock.calls[callIndex]?.[0] as
    | Record<string, unknown>
    | undefined;
  if (!params) {
    throw new Error(`missing compact runtime call ${callIndex}`);
  }
  return params;
}

function configWithSlot(engineId: string): OpenClawConfig {
  return { plugins: { slots: { contextEngine: engineId } } };
}

function makeMockMessage(text = "hello"): AgentMessage {
  return { role: "user", content: text, timestamp: 1 };
}

let restoreContextEngineRegistry: () => Promise<void> = async () => {};

beforeAll(() => {
  restoreContextEngineRegistry = captureContextEngineRegistryStateForTests();
});

afterAll(() => restoreContextEngineRegistry());

let uniqueEngineIdCounter = 0;
function uniqueEngineId(prefix: string): string {
  uniqueEngineIdCounter += 1;
  return `${prefix}-${uniqueEngineIdCounter}`;
}

async function withCompactionDelegateFixture(
  acceptSessionKey: boolean,
  run: (engine: ContextEngine) => Promise<void>,
) {
  await registerLegacyContextEngine();
  const engineId = uniqueEngineId("compaction-projection");
  const compact = vi.fn<ContextEngine["compact"]>(delegateCompactionToRuntime);
  await registerTestContextEngine(engineId, () => ({
    info: {
      id: engineId,
      name: "Compaction projection",
      acceptedHostParams: acceptSessionKey
        ? ["sessionKey", "runtimeContext", "sessionTarget"]
        : ["runtimeContext", "sessionTarget"],
    },
    ...createPassthroughEngineMethods(),
    ingest: async () => ({ ingested: false }),
    compact,
  }));
  const resolution = await resolveLogicalTurnContextEngines(configWithSlot(engineId));
  try {
    await run(resolution.configured.engine);
    expect(compact).toHaveBeenCalledOnce();
    if (!acceptSessionKey) {
      // The registry, not an invalid typed call, owns host-field omission.
      expect(compact.mock.calls[0]?.[0]).not.toHaveProperty("sessionKey");
    }
  } finally {
    await Promise.allSettled([
      resolution.configured.engine.dispose?.(),
      resolution.fallback.engine.dispose?.(),
    ]);
  }
}

function createEngine(id: string, methods: Partial<ContextEngine> = {}): ContextEngine {
  return { info: { id, name: id }, ...createPassthroughEngineMethods(), ...methods };
}

function createFencedEngine(id: string, declaresFence = true): ContextEngine {
  const engine = createEngine(id);
  engine.info.transcriptSemantics = {
    ...(declaresFence ? { currentTurnFence: "before-current-turn-entry-v1" as const } : {}),
    turnAdvancementIdempotency: "atomic-idempotent-v1",
  };
  engine.commitTurn = async () => ({ status: "committed" });
  return engine;
}

async function registerOwnedEngine(engineId: string, methods: Partial<ContextEngine>) {
  const factory = vi.fn(() =>
    createEngine("lcm", {
      info: { id: "lcm", name: "Lossless Context Manager", ownsCompaction: true },
      ...methods,
    }),
  );
  await registerContextEngineForOwner(engineId, factory, "plugin:lossless-claw", {
    allowSameOwnerRefresh: true,
  });
  return factory;
}

function createLease(engineId?: string, warn = vi.fn()) {
  return createContextEngineLogicalTurnLease({
    identity: { runId: "test-run", sessionId: "test-session" },
    config: engineId ? configWithSlot(engineId) : undefined,
    warn,
  });
}

describe("Engine contract tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    compactEmbeddedAgentSessionOnDemandMock.mockReset();
    clearMemoryPluginState();
  });

  it("delegateCompactionToRuntime reuses the legacy runtime bridge", async () => {
    const sessionTarget = {
      agentId: "main",
      sessionId: "s2",
      sessionKey: "agent:main:s2",
      storePath: "/tmp/openclaw-agent.sqlite",
    };
    const compactRuntimeSpy = installCompactRuntimeSpy(sessionTarget);
    const runtimeContext = {
      workspaceDir: "/tmp/workspace",
      currentTokenCount: 12345,
      agentId: "ignored",
      sessionKey: "agent:ignored:ignored",
      sessionTarget: { agentId: "ignored" },
    };
    const abortSignal = new AbortController().signal;
    const result = await delegateCompactionToRuntime({
      abortSignal,
      agentId: "main",
      sessionId: "s2",
      sessionKey: "agent:main:s2",
      sessionTarget,
      tokenBudget: 4096,
      runtimeContext,
    });

    expect(compactRuntimeSpy).toHaveBeenCalledTimes(1);
    const compactRuntimeParams = requireCompactRuntimeParams(0);
    expect(compactRuntimeParams).toMatchObject({
      abortSignal,
      agentId: "main",
      sessionId: "s2",
      sessionKey: "agent:main:s2",
      sessionTarget,
      tokenBudget: 4096,
      currentTokenCount: 12345,
      workspaceDir: "/tmp/workspace",
    });
    expect(compactRuntimeParams).not.toHaveProperty("sessionFile");
    expect(compactRuntimeParams.contextEngineRuntimeContext).toBe(runtimeContext);
    expect(result).toEqual({
      ok: true,
      compacted: false,
      reason: "mock compaction",
      result: {
        summary: "",
        firstKeptEntryId: "",
        tokensBefore: 0,
        tokensAfter: 0,
        details: undefined,
        sessionTarget,
      },
    });
  });

  it("rejects a structured successor key from another agent", async () => {
    await expect(
      delegateCompactionToRuntime({
        sessionId: "s-agent-conflict",
        sessionKey: "agent:main:s-agent-conflict",
        sessionTarget: {
          agentId: "worker",
          sessionId: "s-agent-conflict",
          sessionKey: "agent:main:s-agent-conflict",
          storePath: "/tmp/openclaw-agent.sqlite",
        },
        tokenBudget: 4096,
      }),
    ).rejects.toThrow("successor target conflicts with the caller session identity");
    expect(compactEmbeddedAgentSessionOnDemandMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: "caller agent", agentId: "worker" },
    { name: "physical session", sessionId: "another-session" },
    { name: "caller key", sessionKey: "agent:main:another-key" },
    {
      name: "target-only parsed key",
      agentId: undefined,
      projectSessionKey: true,
      sessionTarget: { agentId: "worker", sessionKey: "agent:main:session" },
    },
  ])(
    "rejects $name before a backend with no nested result can run",
    async ({ name: _name, projectSessionKey, ...input }) => {
      compactEmbeddedAgentSessionOnDemandMock.mockResolvedValue({ ok: true, compacted: true });
      await withCompactionDelegateFixture(!projectSessionKey, async (engine) => {
        await expect(
          engine.compact({
            agentId: "main",
            sessionId: "session",
            sessionKey: "agent:main:session",
            sessionTarget: {
              agentId: "main",
              sessionId: "session",
              sessionKey: "agent:main:session",
            },
            ...input,
          }),
        ).rejects.toThrow(/conflicts with/);
        expect(compactEmbeddedAgentSessionOnDemandMock).not.toHaveBeenCalled();
      });
    },
  );

  it("normalizes runtime identity after host projection omits the caller key", async () => {
    const sessionTarget = {
      agentId: " main ",
      sessionId: " session ",
      sessionKey: " agent:main:session ",
    };
    const runtimeContext = {
      agentId: "main",
      sessionId: "ignored",
      sessionKey: "agent:main:session",
      sessionTarget,
    };
    compactEmbeddedAgentSessionOnDemandMock.mockResolvedValue({ ok: true, compacted: true });
    await withCompactionDelegateFixture(false, async (engine) => {
      const result = await engine.compact({
        sessionId: "session",
        sessionKey: "agent:main:session",
        runtimeContext,
      });
      expect(result).toEqual({ ok: true, compacted: true, reason: undefined, result: undefined });
      expect(requireCompactRuntimeParams(0)).toMatchObject({
        agentId: "main",
        sessionId: "session",
        sessionKey: "agent:main:session",
        sessionTarget,
      });
      expect(requireCompactRuntimeParams(0).contextEngineRuntimeContext).toBe(runtimeContext);
    });
  });

  it("passes agent context through delegated memory prompt assembly", () => {
    registerTestMemoryPromptBuilder(({ agentId, agentSessionKey, sandboxed }) => [
      "## Agent Memory",
      `agent=${agentId} session=${agentSessionKey} sandboxed=${sandboxed}`,
      "",
    ]);

    expect(
      buildMemorySystemPromptAddition({
        availableTools: new Set(["memory_search", "memory_get"]),
        agentId: "marketing-agent",
        agentSessionKey: "agent:marketing-agent:main",
        sandboxed: true,
      }),
    ).toBe(
      "## Agent Memory\nagent=marketing-agent session=agent:marketing-agent:main sandboxed=true",
    );
  });

  it("returns undefined when the active memory prompt path contributes nothing", () => {
    expect(
      buildMemorySystemPromptAddition({
        availableTools: new Set(["memory_search"]),
      }),
    ).toBeUndefined();
  });

  it("prepares async memory state before context-engine prompt rendering", async () => {
    const prepare = vi.fn(async () => ["## Prepared Memory", "loaded from sqlite", ""]);
    registerMemoryPromptPreparation("memory-wiki", prepare);

    await expect(
      prepareMemorySystemPromptAddition({
        availableTools: new Set(["wiki_search"]),
        agentId: "main",
        agentSessionKey: "agent:main:main",
      }),
    ).resolves.toBe("## Prepared Memory\nloaded from sqlite");
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});

describe("Registry tests", () => {
  it("rejects context engine registrations from a different owner", async () => {
    const factory1 = () => new MockContextEngine();
    const factory2 = () => new MockContextEngine();

    expect(
      await registerContextEngineForOwner("reg-owner-guard", factory1, "owner-a", {
        allowSameOwnerRefresh: true,
      }),
    ).toEqual({ ok: true });
    expect(await registerContextEngineForOwner("reg-owner-guard", factory2, "owner-b")).toEqual({
      ok: false,
      existingOwner: "owner-a",
    });
    expect(getContextEngineRegistration("reg-owner-guard")?.factory).toBe(factory1);
  });

  it("reserves the default engine id even in an empty builder registry", () => {
    const building = createEmptyPluginRegistry();

    expect(
      registerContextEngineInRegistry(
        building,
        "legacy",
        () => new MockContextEngine(),
        "plugin:shadow",
      ),
    ).toEqual({ ok: false, existingOwner: "core" });
    expect(building.contextEngines.size).toBe(0);
  });
});

describe("Default engine selection", () => {
  beforeEach(registerLegacyContextEngine);

  it("keeps repeated baseline transcript-host selection stable after the turn starts", async () => {
    const warn = vi.fn();
    const lease = await createLease(undefined, warn);
    const recorder = createUserTurnTranscriptRecorder({ target: () => undefined });
    recorder.markRuntimePersisted();
    const selection = {
      lease,
      host: { id: "agent-harness:test", label: "test harness", capabilities: [] },
      recorder,
    };

    const first = await beginContextEngineLogicalTurn(selection);
    const second = await beginContextEngineLogicalTurn(selection);

    expect(second).toMatchObject({ registeredId: "legacy", mode: "configured" });
    expect(second.engine).toBe(first.engine);
    expect(lease.degraded).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    await lease.dispose();
  });

  it("disposes once after retained turn work rejects", async () => {
    const engineId = uniqueEngineId("logical-turn-retained-work");
    const hold = createDeferred();
    const disposed = createDeferred();
    const engine = new MockContextEngine();
    const dispose = vi.spyOn(engine, "dispose").mockImplementation(async () => {
      disposed.resolve();
    });
    await registerTestContextEngine(engineId, () => engine);
    const lease = await createContextEngineLogicalTurnLease({
      identity: { runId: "retained-run", sessionId: "retained-session" },
      config: configWithSlot(engineId),
    });
    lease.deferDisposalUntil(hold.promise);

    await lease.dispose();
    await lease.dispose();
    expect(dispose).not.toHaveBeenCalled();
    expect(() => lease.begin()).toThrow("already disposed");

    hold.reject(new Error("pending turn work failed"));
    await disposed.promise;
    await lease.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("bounds configured and fallback disposal in parallel", async () => {
    const registry = await import("./registry.js");
    const configured = new MockContextEngine();
    const fallback = new MockContextEngine();
    const configuredGate = createDeferred();
    const fallbackGate = createDeferred();
    const configuredDispose = vi.spyOn(configured, "dispose").mockImplementation(async () => {
      await configuredGate.promise;
    });
    const fallbackDispose = vi
      .spyOn(fallback, "dispose")
      .mockImplementation(() => fallbackGate.promise);
    const resolve = vi.spyOn(registry, "resolveLogicalTurnContextEngines").mockResolvedValue({
      configured: { engine: configured, registeredId: "configured" },
      configuredId: "configured",
      fallback: { engine: fallback, registeredId: "legacy" },
    });
    vi.useFakeTimers();
    vi.stubEnv("OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS", "25");
    const scope = createAgentCleanupScope();
    const lease = await createContextEngineLogicalTurnLease({
      identity: { runId: "parallel-run", sessionId: "parallel-session" },
      warn: vi.fn(),
    });
    let settled = false;
    const cleanup = scope
      .run(() => lease.dispose())
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
      await lease.dispose();
      expect(configuredDispose).toHaveBeenCalledOnce();
      expect(fallbackDispose).toHaveBeenCalledOnce();
    } finally {
      configuredGate.resolve();
      fallbackGate.resolve();
      await cleanup;
      vi.useRealTimers();
      vi.unstubAllEnvs();
      resolve.mockRestore();
    }
  });

  it.each(["missing", "discovery", "factory"] as const)(
    "degrades and warns for %s resolution",
    async (failure) => {
      const engineId = uniqueEngineId(failure);
      if (failure !== "missing") {
        await registerContextEngineForOwner(
          engineId,
          () => {
            if (failure === "factory") {
              throw new Error("factory unavailable");
            }
            return new MockContextEngine();
          },
          `test:${engineId}`,
          { lifecycle: failure === "discovery" ? "readOnlyDiscovery" : "runtime" },
        );
      }
      const warn = vi.fn();
      const lease = await createLease(engineId, warn);
      expect(lease.effectiveEngineId).toBe("legacy");
      expect(lease.degraded).toBe(true);
      expect(lease.degradedReason).toBe(
        failure === "factory"
          ? "factory unavailable"
          : `context engine "${engineId}" is ${failure === "missing" ? "not registered" : "available for discovery only"}`,
      );
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(`Context engine "${engineId}" degraded to "legacy"`),
      );
      await lease.dispose();
    },
  );

  it("does not replay a started engine operation and retries the configured engine next turn", async () => {
    const engineId = uniqueEngineId("logical-turn-retry");
    const assemble = vi
      .fn<ContextEngine["assemble"]>()
      .mockRejectedValueOnce(new Error("configured engine unavailable"))
      .mockImplementation(async ({ messages }) => ({ messages, estimatedTokens: 0 }));
    await registerTestContextEngine(engineId, () => createEngine(engineId, { assemble }));
    const warn = vi.fn();
    const first = await createLease(engineId, warn);
    const messages = [makeMockMessage()];

    first.begin();
    await expect(first.engine.assemble({ sessionId: "first", messages })).rejects.toThrow(
      "configured engine unavailable",
    );
    expect(first.degraded).toBe(false);
    expect(first.engine.info.id).toBe(engineId);
    expect(assemble).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    await first.dispose();

    const second = await createLease(engineId, warn);
    await expect(second.engine.assemble({ sessionId: "second", messages })).resolves.toMatchObject({
      messages,
    });
    expect(second.degraded).toBe(false);
    expect(second.engine.info.id).toBe(engineId);
    expect(assemble).toHaveBeenCalledTimes(2);
    await second.dispose();
  });

  it("rejects an incompatible fallback host after the logical turn starts", async () => {
    const engineId = uniqueEngineId("logical-turn-host-transition");
    await registerTestContextEngine(engineId, () => {
      const engine = createFencedEngine(engineId);
      engine.info.hostRequirements = {
        "agent-run": { requiredCapabilities: ["thread-bootstrap-projection"] },
      };
      return engine;
    });
    const lease = await createLease(engineId);

    lease.selectForHost({
      host: {
        id: "agent-harness:first",
        label: 'agent harness "first"',
        capabilities: ["thread-bootstrap-projection"],
      },
      operation: "agent-run",
      requiresDurableCommit: true,
    });
    lease.begin();

    expect(() =>
      lease.selectForHost({
        host: {
          id: "agent-harness:fallback",
          label: 'agent harness "fallback"',
          capabilities: [],
        },
        operation: "agent-run",
        requiresDurableCommit: true,
      }),
    ).toThrow(
      'context-engine logical turn cannot change to incompatible agent harness "fallback": host "agent-harness:fallback" is missing thread-bootstrap-projection',
    );
    expect(lease.engine.info.id).toBe(engineId);
    await lease.dispose();
  });

  it.each([
    [true, true, "legacy", "current-turn transcript admission receipt is unavailable"],
    [false, true, "configured", undefined],
    [false, false, "legacy", "current-turn transcript fencing is not declared"],
  ] as const)(
    "selects %s persisted / %s fenced turn as %s",
    async (persisted, declaresFence, expectedEngine, expectedReason) => {
      const engineId = uniqueEngineId("logical-turn-recorder-state");
      await registerTestContextEngine(engineId, () => createFencedEngine(engineId, declaresFence));
      const warn = vi.fn();
      const lease = await createLease(engineId, warn);

      const recorder = createUserTurnTranscriptRecorder({ target: () => undefined });
      if (persisted) {
        recorder.markRuntimePersisted();
      }
      const drain = vi
        .spyOn(turnAdmission, "drainPendingContextEngineTurnsBeforeRun")
        .mockResolvedValue(undefined);
      const selected = await beginContextEngineLogicalTurn({
        lease,
        host: { id: "agent-harness:test", label: "test harness", capabilities: [] },
        recorder,
      }).finally(() => drain.mockRestore());

      expect(selected.engine.info.id).toBe(expectedEngine === "configured" ? engineId : "legacy");
      expect(lease.degradedReason).toBe(expectedReason);
      if (expectedReason) {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(expectedReason));
      } else {
        expect(warn).not.toHaveBeenCalled();
      }
      await lease.dispose();
    },
  );
});

describe("Read-only plugin discovery registrations", () => {
  beforeEach(async () => {
    await registerLegacyContextEngine();
    await resetContextEngineRuntimeQuarantineForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not construct or quarantine read-only discovery context-engine factories", async () => {
    const engineId = uniqueEngineId("lossless-readonly");
    const owner = "plugin:lossless-claw";
    const readOnly = vi.fn(() => {
      throw new Error("discovery factory must not run");
    });
    const runtime = vi.fn(() => createEngine("lossless-claw"));
    const registerDiscovery = () =>
      registerContextEngineForOwner(engineId, readOnly, owner, {
        allowSameOwnerRefresh: true,
        lifecycle: "readOnlyDiscovery",
      });
    await registerDiscovery();
    expect((await resolveContextEngine(configWithSlot(engineId))).info.id).toBe("legacy");
    expect(readOnly).not.toHaveBeenCalled();
    expect(await listContextEngineQuarantines()).toEqual([]);
    expect(console.warn).toHaveBeenCalledOnce();

    await registerContextEngineForOwner(engineId, runtime, owner, {
      allowSameOwnerRefresh: true,
      lifecycle: "runtime",
    });
    expect((await resolveContextEngine(configWithSlot(engineId))).info.id).toBe("lossless-claw");
    expect(runtime).toHaveBeenCalledOnce();
    expect(await listContextEngineQuarantines()).toEqual([]);

    await registerDiscovery();
    expect((await resolveContextEngine(configWithSlot(engineId))).info.id).toBe("lossless-claw");
    expect(readOnly).not.toHaveBeenCalled();
    expect(runtime).toHaveBeenCalledTimes(2);
  });
});

describe("Invalid engine fallback", () => {
  beforeEach(async () => {
    await registerLegacyContextEngine();
    await resetContextEngineRuntimeQuarantineForTests();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to default engine for missing or invalid requested engines", async () => {
    const cases: Array<[string, ContextEngineFactory | undefined, string, RegExp]> = [
      ["missing", undefined, "resolve", /not registered/],
      [
        "throws",
        () => {
          throw new Error("plugin version mismatch");
        },
        "factory",
        /plugin version mismatch/,
      ],
      [
        "missing-info",
        () => createPassthroughEngineMethods() as ContextEngine,
        "contract-validation",
        /missing info/,
      ],
      [
        "missing-methods",
        () =>
          ({
            info: { id: "broken", name: "Broken" },
            ingest: async () => ({ ingested: false }),
          }) as unknown as ContextEngine,
        "contract-validation",
        /missing assemble\(\), missing compact\(\)/,
      ],
      ["validation-throws", () => 42n as unknown as ContextEngine, "contract-validation", /BigInt/],
    ];
    for (const [name, factory, operation, reason] of cases) {
      const engineId = uniqueEngineId(name);
      vi.mocked(console.error).mockClear();
      if (factory) {
        await registerTestContextEngine(engineId, factory);
      }
      expect((await resolveContextEngine(configWithSlot(engineId))).info.id).toBe("legacy");
      expect(console.error).toHaveBeenCalledWith(expect.stringMatching(reason));
      expect(await listContextEngineQuarantines()).toContainEqual(
        expect.objectContaining({
          engineId,
          operation,
          reason: expect.stringMatching(reason),
        }),
      );
    }
  });

  it("coalesces fallback initialization across concurrent lifecycle failures", async () => {
    const defaultFactory = vi.fn(async () => new LegacyContextEngine());
    await registerContextEngineForOwner("legacy", defaultFactory, "core", {
      allowSameOwnerRefresh: true,
    });
    const engineId = uniqueEngineId("concurrent-runtime-fail");
    const assemble = vi.fn(async () => {
      await Promise.resolve();
      throw new Error("plugin context unavailable");
    });
    await registerTestContextEngine(engineId, () => createEngine(engineId, { assemble }));
    const engine = await resolveContextEngine(configWithSlot(engineId));
    const messages = [makeMockMessage("first"), makeMockMessage("second")];

    const results = await Promise.all(
      messages.map((message, index) =>
        engine.assemble({ sessionId: `session-${index}`, messages: [message] }),
      ),
    );

    expect(results.map(({ messages: assembled }) => assembled)).toEqual(
      messages.map((message) => [message]),
    );
    expect(assemble).toHaveBeenCalledTimes(2);
    expect(defaultFactory).toHaveBeenCalledTimes(1);
    expect(await listContextEngineQuarantines()).toEqual([
      expect.objectContaining({ engineId, operation: "assemble" }),
    ]);
  });

  it("routes legacy resolver fence failures through normal quarantine", async () => {
    const engineId = uniqueEngineId("transcript-fence-fallback");
    const ingest = vi.fn(async () => ({ ingested: true }));
    const assemble = vi.fn(async () => {
      throw new SessionTranscriptReadFenceError("admitted user row is unavailable");
    });
    const factory = await registerOwnedEngine(engineId, { ingest, assemble });

    const engine = await resolveContextEngine(configWithSlot(engineId));
    expect(engine.info.id).toBe("lcm");
    expect(engine.info.ownsCompaction).toBe(true);
    expect(resolveContextEngineOwnerPluginId(engine)).toBe("lossless-claw");

    const first = makeMockMessage("first");
    const second = makeMockMessage("second");
    await expect(engine.assemble({ sessionId: "s1", messages: [first] })).resolves.toMatchObject({
      messages: [first],
    });
    await expect(engine.assemble({ sessionId: "s1", messages: [second] })).resolves.toMatchObject({
      messages: [second],
    });
    await engine.ingest({ sessionId: "s1", message: second });

    expect(engine.info.id).toBe("legacy");
    expect(engine.info.ownsCompaction).toBeUndefined();
    expect((await resolveContextEngine(configWithSlot(engineId))).info.id).toBe("legacy");
    expect(factory).toHaveBeenCalledOnce();
    expect(resolveContextEngineOwnerPluginId(engine)).toBeUndefined();
    expect(await listContextEngineQuarantines()).toEqual([
      expect.objectContaining({
        engineId,
        operation: "assemble",
        reason: "admitted user row is unavailable",
      }),
    ]);
    expect(assemble).toHaveBeenCalledTimes(1);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("quarantines compact failures without same-call legacy fallback", async () => {
    const engineId = uniqueEngineId("runtime-fail-compact");
    const compact = vi.fn(async () => {
      throw new Error("plugin compaction failed");
    });
    await registerOwnedEngine(engineId, { compact });

    const engine = await resolveContextEngine(configWithSlot(engineId));

    await expect(engine.compact({ sessionId: "s1", sessionKey: "agent:main:s1" })).rejects.toThrow(
      "plugin compaction failed",
    );

    expect(engine.info.id).toBe("legacy");
    expect(engine.info.ownsCompaction).toBeUndefined();
    expect(resolveContextEngineOwnerPluginId(engine)).toBeUndefined();
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("clears a missing-engine quarantine when the plugin registers later", async () => {
    const engineId = uniqueEngineId("late-register");
    expect((await resolveContextEngine(configWithSlot(engineId))).info.id).toBe("legacy");
    expect(await listContextEngineQuarantines()).toEqual([
      expect.objectContaining({ engineId, operation: "resolve", reason: "not registered" }),
    ]);
    await registerTestContextEngine(engineId, () => createEngine(engineId));
    expect(await listContextEngineQuarantines()).toEqual([]);
    expect((await resolveContextEngine(configWithSlot(engineId))).info.id).toBe(engineId);
  });

  it("does not quarantine a cancelled compaction", async () => {
    const engineId = uniqueEngineId("compact-abort");
    const controller = new AbortController();
    const reason = new Error("user stopped compaction");
    const error = new Error("compaction aborted", { cause: reason });
    error.name = "AbortError";
    await registerTestContextEngine(engineId, () =>
      createEngine(engineId, {
        async compact() {
          controller.abort(reason);
          throw error;
        },
      }),
    );
    const engine = await resolveContextEngine(configWithSlot(engineId));
    await expect(
      engine.compact({
        sessionId: "s1",
        sessionKey: "agent:main:s1",
        abortSignal: controller.signal,
      }),
    ).rejects.toBe(error);
    expect((await resolveContextEngine(configWithSlot(engineId))).info.id).toBe(engineId);
    expect(await listContextEngineQuarantines()).toEqual([]);
  });

  it("defers quarantine clearing for builder-context direct registrations", async () => {
    const engineId = uniqueEngineId("builder-register");
    await resolveContextEngine(configWithSlot(engineId));
    const builder = createEmptyPluginRegistry();

    await withPluginRegistrationContext(builder, "context-builder", async () => {
      await registerContextEngineForOwner(
        engineId,
        () => new MockContextEngine(),
        "plugin:context-builder",
        { allowSameOwnerRefresh: true },
      );
    });

    expect(builder.contextEngines.has(engineId)).toBe(true);
    expect(getContextEngineRegistration(engineId)).toBeUndefined();
    expect(await listContextEngineQuarantines()).toEqual([
      expect.objectContaining({ engineId, reason: "not registered" }),
    ]);

    setActivePluginRegistry(builder);
    activateContextEngineRegistrations(builder);
    expect(await listContextEngineQuarantines()).toEqual([]);
  });

  it.each(["before", "during", "never"] as const)(
    "handles maintenance failure when abort is %s",
    async (abortAt) => {
      const engineId = uniqueEngineId("maintenance-abort");
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
      await registerTestContextEngine(engineId, () => createEngine(engineId, { maintain }));
      if (abortAt === "before") {
        controller.abort(reason);
      }
      const engine = await resolveContextEngine(configWithSlot(engineId));
      const maintenance = engine.maintain?.({
        sessionId: "s1",
        sessionFile: "/tmp/s1.jsonl",
        abortSignal: controller.signal,
      });
      if (abortAt === "never") {
        await expect(maintenance).resolves.toMatchObject({ changed: false });
        expect(controller.signal.aborted).toBe(false);
        expect((await resolveContextEngine(configWithSlot(engineId))).info.id).toBe("legacy");
        expect(await listContextEngineQuarantines()).toEqual([
          expect.objectContaining({ engineId, operation: "maintain", reason: abortError.message }),
        ]);
      } else {
        await expect(maintenance).rejects.toBe(abortAt === "before" ? reason : abortError);
        expect((await resolveContextEngine(configWithSlot(engineId))).info.id).toBe(engineId);
        expect(await listContextEngineQuarantines()).toEqual([]);
      }
      expect(maintain).toHaveBeenCalledTimes(abortAt === "before" ? 0 : 1);
    },
  );

  it("quarantines subagent preparation failures while failing the active spawn closed", async () => {
    const engineId = uniqueEngineId("prepare-subagent-fail");
    await registerTestContextEngine(engineId, () =>
      createEngine(engineId, {
        async prepareSubagentSpawn() {
          throw new Error("child context projection failed");
        },
      }),
    );

    const engine = await resolveContextEngine(configWithSlot(engineId));

    await expect(
      engine.prepareSubagentSpawn?.({
        parentSessionKey: "agent:main",
        childSessionKey: "agent:child",
        contextMode: "isolated",
      }),
    ).rejects.toThrow("child context projection failed");

    const nextEngine = await resolveContextEngine(configWithSlot(engineId));
    expect(nextEngine.info.id).toBe("legacy");
    expect(await listContextEngineQuarantines()).toEqual([
      expect.objectContaining({
        engineId,
        operation: "prepareSubagentSpawn",
        reason: "child context projection failed",
      }),
    ]);
  });

  it("throws when the default engine itself is not registered", async () => {
    const engines = requireActivePluginRegistry().contextEngines;
    const snapshot = new Map(engines);
    engines.clear();

    try {
      await expect(resolveContextEngine()).rejects.toThrow("not registered");
    } finally {
      for (const [key, value] of snapshot) {
        engines.set(key, value);
      }
    }
  });

  it("propagates error when default engine fails contract validation", async () => {
    await registerContextEngineForOwner(
      "legacy",
      () => ({ broken: true }) as unknown as ContextEngine,
      "core",
      { allowSameOwnerRefresh: true },
    );

    await expect(resolveContextEngine()).rejects.toThrow(
      'Context engine "legacy" factory returned an invalid ContextEngine',
    );
  });
});

describe("Bundle chunk isolation (#40096)", () => {
  it("shares registrations and keeps concurrent chunk registration visible", async () => {
    const ts = Date.now().toString(36);
    const registryUrl = new URL("./registry.ts", import.meta.url).href;
    const dynamicChunk = await import(/* @vite-ignore */ `${registryUrl}?chunk=${ts}-dynamic`);
    const chunks = [
      {
        registerContextEngineForOwner,
        getContextEngineRegistration,
        resolveContextEngine,
      },
      dynamicChunk,
    ];

    const engineId = `cross-chunk-${ts}`;
    const factory = () => createEngine(engineId);
    await chunks[0].registerContextEngineForOwner(engineId, factory, `test:${engineId}`);

    expect(chunks[1].getContextEngineRegistration(engineId)?.factory).toBe(factory);
    const engine = await chunks[1].resolveContextEngine(configWithSlot(engineId));
    expect(engine.info.id).toBe(engineId);

    const ids = chunks.map((_, i) => `concurrent-${ts}-${i}`);
    const registrationTasks = chunks.map((chunk, i) =>
      Promise.resolve().then(async () => {
        const id = `concurrent-${ts}-${i}`;
        await chunk.registerContextEngineForOwner(id, () => new MockContextEngine(), `test:${id}`);
      }),
    );
    await Promise.all(registrationTasks);

    for (const id of ids) {
      expect(chunks[0].getContextEngineRegistration(id)).toBeDefined();
    }
  });
});
