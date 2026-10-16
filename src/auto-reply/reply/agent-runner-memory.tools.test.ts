// Provider-owned pre-compaction persistence through detached maintenance turns.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  assertMemoryFlushPersistenceToolAvailable,
  projectMemoryFlushTools,
} from "../../agents/agent-tools.memory-flush.js";
import type { AnyAgentTool } from "../../agents/agent-tools.types.js";
import { createSessionMaintenanceFollowup } from "../../agents/session-maintenance/run.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../../agents/test-helpers/assistant-message-fixtures.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { isInternalSessionEffectsKey } from "../../config/sessions/internal-session-key.js";
import {
  loadSessionEntry,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { createSessionTranscriptHeader } from "../../config/sessions/transcript-header.js";
import { assertMemoryAudienceSession } from "../../plugins/memory-audience.js";
import { clearMemoryPluginState } from "../../plugins/memory-state.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { setPluginToolMeta } from "../../plugins/tool-metadata.js";
import { runMemoryFlushIfNeeded } from "./agent-runner-memory.js";
import {
  createMemoryRunEntryMockImplementation,
  createFlushSessionEntry,
  modelRoutingProvenance,
  runInitialMemoryFallback,
  type EmbeddedAgentParams,
  type ModelFallbackParams,
} from "./agent-runner-memory.test-support.js";
import {
  createTestFollowupRun,
  withTestModelContextTokens,
  writeTestSessionStore,
} from "./agent-runner.test-fixtures.js";

const { runEntry, runAgent, warn, debug } = vi.hoisted(() => ({
  runEntry: vi.fn(),
  runAgent: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));
const runFallback = vi.fn();

vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (...args: Parameters<typeof actual.createSubsystemLogger>) => {
      const logger = actual.createSubsystemLogger(...args);
      return args[0] === "auto-reply/memory-flush" ? { ...logger, warn, debug } : logger;
    },
  };
});
vi.mock("../../agents/embedded-agent-runner/run-entry.js", () => ({
  runEmbeddedAgentEntry: runEntry,
}));
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: runAgent }));
vi.mock("../../infra/agent-run-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/agent-run-registry.js")>()),
  registerAgentRunContext: vi.fn(),
  clearAgentRunContext: vi.fn(),
}));

function requireEmbeddedAgentCall(index = 0) {
  const call = runAgent.mock.calls[index]?.[0] as EmbeddedAgentParams | undefined;
  if (!call) {
    throw new Error(`runEmbeddedAgent call ${index} missing`);
  }
  return call;
}

const readOnlyWorkspace = {
  agents: { defaults: { sandbox: { mode: "all", workspaceAccess: "ro" } } },
} as const;

describe("provider-owned memory flush", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let rootDir = "";

  beforeEach(() => {
    rootDir = tempDirs.make("openclaw-memory-tools-");
    runFallback.mockReset().mockImplementation(runInitialMemoryFallback);
    runEntry.mockReset().mockImplementation(createMemoryRunEntryMockImplementation(runFallback));
    runAgent.mockReset().mockResolvedValue({ payloads: [], meta: {} });
    warn.mockReset();
    debug.mockReset();
    registerToolsFlushPlan();
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearMemoryPluginState();
  });

  function registerToolsFlushPlan(sidecar = false) {
    const registry = createEmptyPluginRegistry();
    const providerFlushPlanResolver = () => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 20_000,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Persist memory with knowledge_save_page.",
      persistenceToolNames: ["knowledge_save_page"],
      lookupToolNames: ["knowledge_grep"],
    });
    registry.memoryCapabilities.push({
      pluginId: "knowledge",
      memorySlotSelected: true,
      capability: sidecar
        ? {}
        : {
            providerFlushPlanResolver,
            providerRuntime: { open: vi.fn(async () => ({ provider: null })) },
          },
    });
    if (sidecar) {
      registry.memoryCapabilities.push({
        pluginId: "memory-sidecar",
        capability: { providerFlushPlanResolver },
      });
    }
    setActivePluginRegistry(registry);
  }

  async function createToolsFlushFixture(entryOverrides: Partial<SessionEntry> = {}) {
    const sessionKey = "agent:main:main";
    const storePath = path.join(rootDir, "sessions.json");
    const entry = createFlushSessionEntry({
      sessionId: "10000000-0000-4000-8000-000000000001",
      lifecycleRevision: "incarnation-1",
      chatType: "direct",
      ...entryOverrides,
    });
    await writeTestSessionStore(storePath, sessionKey, entry);
    const followupRun = createTestFollowupRun({
      sessionId: entry.sessionId,
      sessionKey,
      senderIsOwner: true,
      workspaceDir: rootDir,
    });
    const overrides = { sessionKey, storePath, followupRun };
    const flush = (options: Partial<Parameters<typeof runMemoryFlushIfNeeded>[0]> = {}) => {
      const params = {
        defaultModel: "anthropic/claude-opus-4-6",
        resolvedVerboseLevel: "off" as const,
        sessionEntry: options.sessionEntry ?? entry,
        sessionStore: { [sessionKey]: options.sessionEntry ?? entry },
        isHeartbeat: false,
        ...overrides,
        ...options,
      };
      return runMemoryFlushIfNeeded({
        ...params,
        cfg: withTestModelContextTokens({
          ...params,
          cfg: params.cfg ?? {},
          contextTokens: 100_000,
        }),
      });
    };
    return { entry, overrides, flush };
  }

  // Exercise the production success wrapper, not a synthetic persistence callback.
  async function persistMemory(params: EmbeddedAgentParams) {
    if (!params.memoryFlushTools) {
      throw new Error("missing tools-arm run context");
    }
    const tool: AnyAgentTool = {
      name: "knowledge_save_page",
      label: "Save page",
      description: "Persist a page",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "saved" }], details: {} }),
    };
    setPluginToolMeta(tool, { pluginId: "knowledge", optional: false });
    const [projected] = projectMemoryFlushTools([tool], { ...params.memoryFlushTools });
    if (!projected) {
      throw new Error("declared persistence tool was not projected");
    }
    await projected.execute("flush-save", {});
    return { payloads: [], meta: {} };
  }

  it("flushes transcript pressure without provider usage without publishing estimated usage", async () => {
    const { entry, overrides, flush } = await createToolsFlushFixture({
      totalTokens: 2,
      totalTokensFresh: false,
    });
    const scope = { ...overrides, agentId: "main", sessionId: entry.sessionId };
    const transcript = SessionManager.fromEntries([
      createSessionTranscriptHeader({ cwd: rootDir, sessionId: entry.sessionId }),
    ]);
    await transcript.appendMessageAsync({
      role: "user",
      content: "x".repeat(310_000),
      timestamp: 1,
    });
    await transcript.appendMessageAsync(
      makeAssistantMessageFixture({
        content: [{ type: "text", text: "Acknowledged" }],
        usage: undefined,
        stopReason: "stop",
        errorMessage: undefined,
      }),
    );
    await replaceTranscriptEvents(scope, [transcript.getHeader(), ...transcript.getEntries()]);
    await waitForSessionTranscriptProjection(scope);
    runAgent.mockImplementationOnce(persistMemory);

    const result = await flush({ promptForEstimate: "" });

    expect(result.outcome).toBe("completed");
    expect(runAgent).toHaveBeenCalledOnce();
    expect(loadSessionEntry(scope)).toMatchObject({
      totalTokens: 2,
      totalTokensFresh: false,
      memoryFlush: { kind: "succeeded", compactionCount: 1 },
    });
  });

  it("does not flush empty history for a large pending input with fresh tokens", async () => {
    const { flush } = await createToolsFlushFixture({
      totalTokens: 0,
      totalTokensFresh: true,
    });

    const result = await flush({ promptForEstimate: "x".repeat(310_000) });

    expect(result.outcome).toBe("skipped");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("does not resolve a legacy file plan for a session that cannot write its workspace", async () => {
    const registry = createEmptyPluginRegistry();
    const flushPlanResolver = vi.fn(() => {
      throw new Error("legacy resolver failed");
    });
    registry.memoryCapabilities.push({
      pluginId: "third-party-memory",
      memorySlotSelected: true,
      capability: { flushPlanResolver },
    });
    setActivePluginRegistry(registry);
    const { flush } = await createToolsFlushFixture();

    const result = await flush({ cfg: readOnlyWorkspace });

    expect(result.outcome).toBe("skipped");
    expect(flushPlanResolver).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("delegates the source audience to detached tools flushes with source sandbox policy", async () => {
    const { entry, overrides, flush } = await createToolsFlushFixture();
    runAgent.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      expect(params).toMatchObject({
        sessionPersistence: "detached",
        senderIsOwner: false,
        sandboxSessionKey: overrides.sessionKey,
        memoryAudience: { kind: "owner-private", agentId: "main" },
        memoryFlushTools: {
          ownerPluginId: "knowledge",
          persistenceToolNames: ["knowledge_save_page"],
          lookupToolNames: ["knowledge_grep"],
          flushId: expect.any(String),
        },
      });
      expect(params.sessionId).not.toBe(entry.sessionId);
      expect(isInternalSessionEffectsKey(params.sessionKey ?? "")).toBe(true);
      expect(params.memoryFlushWritePath).toBeUndefined();
      const audience = params.memoryAudience;
      if (!audience) {
        throw new Error("source memory audience missing");
      }
      expect(() => assertMemoryAudienceSession(audience, params.sessionKey)).not.toThrow();
      expect(() => assertMemoryAudienceSession(audience, overrides.sessionKey)).toThrow(
        "bound to a different session",
      );
      return persistMemory(params);
    });

    const result = await flush({ cfg: readOnlyWorkspace });

    expect(result.outcome).toBe("completed");
    expect(runAgent).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(rootDir, "memory"))).toBe(false);
  });

  it("keeps a tools flush ID across fallback and retry, then changes it after compaction", async () => {
    const { entry, overrides, flush } = await createToolsFlushFixture();
    runAgent.mockRejectedValueOnce(new Error("model unavailable"));
    runFallback.mockImplementationOnce(async (params: ModelFallbackParams) => {
      await expect(
        params.run("anthropic", "claude", {
          modelRoutingProvenance: modelRoutingProvenance("anthropic", "claude"),
        }),
      ).rejects.toThrow("model unavailable");
      return {
        result: await params.run("anthropic", "fallback", {
          modelRoutingProvenance: modelRoutingProvenance("anthropic", "claude", "fallback"),
        }),
        provider: "anthropic",
        model: "fallback",
        attempts: [],
      };
    });
    overrides.followupRun.run.thinkingCatalog?.push({
      provider: "anthropic",
      id: "fallback",
      input: ["text"],
    });

    // Neither fallback writes: failure permits the next flush invocation to retry.
    const failed = await flush();
    expect(failed.outcome).toBe("failed");
    runAgent.mockImplementation(persistMemory);
    const retried = await flush({ sessionEntry: failed.sessionEntry ?? entry });
    expect(retried.outcome).toBe("completed");
    const nextCycle = { ...retried.sessionEntry!, compactionCount: 2 };
    await writeTestSessionStore(overrides.storePath, overrides.sessionKey, nextCycle);
    expect((await flush({ sessionEntry: nextCycle })).outcome).toBe("completed");

    const firstId = requireEmbeddedAgentCall(0).memoryFlushTools?.flushId;
    expect(firstId).toMatch(/^[a-f0-9-]{36}$/);
    expect(requireEmbeddedAgentCall(1).memoryFlushTools?.flushId).toBe(firstId);
    expect(requireEmbeddedAgentCall(2).memoryFlushTools?.flushId).toBe(firstId);
    expect(requireEmbeddedAgentCall(2).sessionKey).not.toBe(requireEmbeddedAgentCall(0).sessionKey);
    expect(requireEmbeddedAgentCall(3).memoryFlushTools?.flushId).not.toBe(firstId);
  });

  it.each([
    ["non-owner direct", "direct", false],
    ["owner group", "group", true],
  ] as const)(
    "resolves a post-turn maintenance flush audience from its %s source turn",
    async (_name, chatType, senderIsOwner) => {
      const { entry, overrides, flush } = await createToolsFlushFixture({ chatType });
      const source = overrides.followupRun.run;
      source.senderIsOwner = senderIsOwner;
      // The scheduled post-turn copy, as reply and command maintenance build it.
      const maintenance = createSessionMaintenanceFollowup({
        run: source,
        sessionEntry: entry,
        cfg: {},
        sessionKey: overrides.sessionKey,
        provider: source.provider,
        model: source.model,
        auth: source,
      });
      runAgent.mockImplementationOnce(persistMemory);

      const result = await flush({ followupRun: maintenance });

      expect(result.outcome).toBe("completed");
      expect(maintenance.run.senderIsOwner).toBe(false);
      expect(requireEmbeddedAgentCall(0).senderIsOwner).toBe(false);
      expect(requireEmbeddedAgentCall(0).memoryAudience?.kind).toBe("conversation");
    },
  );

  it("rejects an earlier silent reply as persistence evidence", async () => {
    const { overrides, flush } = await createToolsFlushFixture();
    runAgent.mockResolvedValueOnce({
      payloads: [{ text: "NO_REPLY" }, { text: "Finished." }],
      meta: { finalAssistantRawText: "Finished." },
    });

    const result = await flush();

    expect(result.outcome).toBe("failed");
    expect(loadSessionEntry(overrides)?.memoryFlush).toMatchObject({ kind: "failed" });
  });

  it("skips tools flush without a source memory audience", async () => {
    const { flush } = await createToolsFlushFixture({ chatType: undefined });

    expect((await flush()).outcome).toBe("skipped");
    expect(runAgent).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining("no memory audience"),
      expect.objectContaining({ pluginId: "knowledge" }),
    );
  });

  it("warns and skips a tools plan contributed by a non-owner sidecar", async () => {
    registerToolsFlushPlan(true);
    const { flush } = await createToolsFlushFixture();

    expect((await flush()).outcome).toBe("skipped");
    expect(runEntry).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('plugin "memory-sidecar"'));
  });

  it("treats unavailable persistence tools as a skip instead of spending a failure attempt", async () => {
    const { overrides, flush } = await createToolsFlushFixture();
    runAgent.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      assertMemoryFlushPersistenceToolAvailable([], params.memoryFlushTools);
      throw new Error("inference must not run");
    });

    expect((await flush()).outcome).toBe("skipped");
    expect(loadSessionEntry(overrides)?.memoryFlush).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("knowledge_save_page"));
  });
});
