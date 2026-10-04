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
import type { ModelFallbackAttemptProvenance } from "../../agents/model-fallback.types.js";
import { createSessionMaintenanceFollowup } from "../../agents/session-maintenance/run.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { isInternalSessionEffectsKey } from "../../config/sessions/internal-session-key.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { assertMemoryAudienceSession } from "../../plugins/memory-audience.js";
import { clearMemoryPluginState } from "../../plugins/memory-state.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { setPluginToolMeta } from "../../plugins/tool-metadata.js";
import { runMemoryFlushIfNeeded } from "./agent-runner-memory.js";
import {
  createMemoryRunEntryMockImplementation,
  type EmbeddedAgentParams,
  type ModelFallbackParams,
} from "./agent-runner-memory.test-support.js";
import {
  createTestFollowupRun,
  withTestModelContextTokens,
  writeTestSessionStore,
} from "./agent-runner.test-fixtures.js";

const {
  runEmbeddedAgentEntryMock,
  runEmbeddedAgentMock,
  memoryFlushWarnMock,
  memoryFlushDebugMock,
} = vi.hoisted(() => ({
  runEmbeddedAgentEntryMock: vi.fn(),
  runEmbeddedAgentMock: vi.fn(),
  memoryFlushWarnMock: vi.fn(),
  memoryFlushDebugMock: vi.fn(),
}));
const runWithModelFallbackMock = vi.fn();

vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (...args: Parameters<typeof actual.createSubsystemLogger>) => {
      const logger = actual.createSubsystemLogger(...args);
      return args[0] === "auto-reply/memory-flush"
        ? { ...logger, warn: memoryFlushWarnMock, debug: memoryFlushDebugMock }
        : logger;
    },
  };
});
vi.mock("../../agents/embedded-agent-runner/run-entry.js", () => ({
  runEmbeddedAgentEntry: runEmbeddedAgentEntryMock,
}));
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: runEmbeddedAgentMock }));
vi.mock("../../infra/agent-run-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/agent-run-registry.js")>()),
  registerAgentRunContext: vi.fn(),
  clearAgentRunContext: vi.fn(),
}));

function modelRoutingProvenance(
  requestedProvider: string,
  requestedModel: string,
  stage: ModelFallbackAttemptProvenance["stage"] = "initial",
): ModelFallbackAttemptProvenance {
  return { requestedProvider, requestedModel, stage };
}

function requireEmbeddedAgentCall(index = 0) {
  const call = runEmbeddedAgentMock.mock.calls[index]?.[0] as EmbeddedAgentParams | undefined;
  if (!call) {
    throw new Error(`runEmbeddedAgent call ${index} missing`);
  }
  return call;
}

type FlushOverrides = Required<
  Pick<Parameters<typeof runMemoryFlushIfNeeded>[0], "sessionKey" | "storePath" | "followupRun">
> &
  Partial<Parameters<typeof runMemoryFlushIfNeeded>[0]>;

// Fix only the model budget; the real flush owner prepares the source and detached session.
async function runDefaultMemoryFlush(sessionEntry: SessionEntry, overrides: FlushOverrides) {
  const defaultModel = "anthropic/claude-opus-4-6";
  return await runMemoryFlushIfNeeded({
    defaultModel,
    resolvedVerboseLevel: "off",
    sessionEntry,
    sessionStore: { [overrides.sessionKey]: sessionEntry },
    ...overrides,
    cfg: withTestModelContextTokens({
      cfg: overrides.cfg ?? {},
      followupRun: overrides.followupRun,
      defaultModel,
      contextTokens: 100_000,
    }),
  });
}

describe("provider-owned memory flush", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let rootDir = "";

  beforeEach(() => {
    rootDir = tempDirs.make("openclaw-memory-tools-");
    runWithModelFallbackMock.mockReset().mockImplementation(async ({ provider, model, run }) => ({
      result: await run(provider, model, {
        modelRoutingProvenance: modelRoutingProvenance(provider, model),
      }),
      provider,
      model,
      attempts: [],
    }));
    runEmbeddedAgentEntryMock.mockReset().mockImplementation(
      createMemoryRunEntryMockImplementation({
        runWithModelFallback: runWithModelFallbackMock,
        ensureSelectedAgentHarnessPlugin: vi.fn().mockResolvedValue(undefined),
      }),
    );
    runEmbeddedAgentMock.mockReset().mockResolvedValue({ payloads: [], meta: {} });
    memoryFlushWarnMock.mockReset();
    memoryFlushDebugMock.mockReset();
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearMemoryPluginState();
  });

  // Tools-arm fixtures use a real host audience and registry slot marker; the
  // existing file-arm fixtures intentionally have neither of these grants.
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
      // A native slot owner registers the provider-neutral runtime with its tools plan.
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
    const entry: SessionEntry = {
      updatedAt: Date.now(),
      totalTokens: 80_000,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      compactionCount: 1,
      sessionId: "10000000-0000-4000-8000-000000000001",
      lifecycleRevision: "incarnation-1",
      chatType: "direct",
      ...entryOverrides,
    };
    await writeTestSessionStore(storePath, sessionKey, entry);
    const followupRun = createTestFollowupRun({
      sessionId: entry.sessionId,
      sessionKey,
      senderIsOwner: true,
      workspaceDir: rootDir,
    });
    return { entry, overrides: { sessionKey, storePath, followupRun } };
  }

  // Execute the production success wrapper so the runner receives evidence
  // from an actual completed tool rather than a fixture invoking its callback.
  async function executePersistenceTool(params: EmbeddedAgentParams) {
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
    const [projected] = projectMemoryFlushTools([tool], {
      ...params.memoryFlushTools,
    });
    if (!projected) {
      throw new Error("declared persistence tool was not projected");
    }
    await projected.execute("flush-save", {});
  }

  async function executeLookupTool(params: EmbeddedAgentParams) {
    if (!params.memoryFlushTools) {
      throw new Error("missing tools-arm run context");
    }
    const tool: AnyAgentTool = {
      name: "knowledge_grep",
      label: "Search pages",
      description: "Search existing memory",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "found" }], details: {} }),
    };
    setPluginToolMeta(tool, { pluginId: "knowledge", optional: false });
    const [projected] = projectMemoryFlushTools([tool], params.memoryFlushTools);
    if (!projected) {
      throw new Error("declared lookup tool was not projected");
    }
    await projected.execute("flush-lookup", {});
  }

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
    const { entry, overrides } = await createToolsFlushFixture();

    const result = await runDefaultMemoryFlush(entry, {
      ...overrides,
      cfg: { agents: { defaults: { sandbox: { mode: "all", workspaceAccess: "ro" } } } },
    });

    expect(result.outcome).toBe("skipped");
    expect(flushPlanResolver).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("delegates the source audience to detached tools flushes with source sandbox policy", async () => {
    registerToolsFlushPlan();
    const { entry, overrides } = await createToolsFlushFixture();
    runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
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
      if (!params.memoryAudience) {
        throw new Error("source memory audience missing");
      }
      expect(() =>
        assertMemoryAudienceSession(params.memoryAudience!, params.sessionKey),
      ).not.toThrow();
      expect(() =>
        assertMemoryAudienceSession(params.memoryAudience!, overrides.sessionKey),
      ).toThrow("bound to a different session");
      await executePersistenceTool(params);
      return { payloads: [], meta: {} };
    });

    const result = await runDefaultMemoryFlush(entry, {
      ...overrides,
      cfg: { agents: { defaults: { sandbox: { mode: "all", workspaceAccess: "ro" } } } },
    });

    expect(result.outcome).toBe("completed");
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(rootDir, "memory"))).toBe(false);
  });

  it("keeps a tools flush ID across fallback and retry, then changes it after compaction", async () => {
    registerToolsFlushPlan();
    const { entry, overrides } = await createToolsFlushFixture();
    runEmbeddedAgentMock.mockRejectedValueOnce(new Error("model unavailable"));
    runWithModelFallbackMock.mockImplementationOnce(async (params: ModelFallbackParams) => {
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
    const failed = await runDefaultMemoryFlush(entry, overrides);
    expect(failed.outcome).toBe("failed");
    runEmbeddedAgentMock.mockImplementation(async (params: EmbeddedAgentParams) => {
      await executePersistenceTool(params);
      return { payloads: [], meta: {} };
    });
    const retried = await runDefaultMemoryFlush(failed.sessionEntry ?? entry, overrides);
    expect(retried.outcome).toBe("completed");
    const nextCycle = { ...retried.sessionEntry!, compactionCount: 2 };
    await writeTestSessionStore(overrides.storePath, overrides.sessionKey, nextCycle);
    expect((await runDefaultMemoryFlush(nextCycle, overrides)).outcome).toBe("completed");

    const firstId = requireEmbeddedAgentCall(0).memoryFlushTools?.flushId;
    expect(firstId).toMatch(/^[a-f0-9-]{36}$/);
    expect(requireEmbeddedAgentCall(1).memoryFlushTools?.flushId).toBe(firstId);
    expect(requireEmbeddedAgentCall(2).memoryFlushTools?.flushId).toBe(firstId);
    expect(requireEmbeddedAgentCall(2).sessionKey).not.toBe(requireEmbeddedAgentCall(0).sessionKey);
    expect(requireEmbeddedAgentCall(3).memoryFlushTools?.flushId).not.toBe(firstId);
  });

  it("gives a reset session incarnation a new tools flush ID", async () => {
    registerToolsFlushPlan();
    const { entry, overrides } = await createToolsFlushFixture();
    runEmbeddedAgentMock.mockImplementation(async (params: EmbeddedAgentParams) => {
      await executePersistenceTool(params);
      return { payloads: [], meta: {} };
    });
    expect((await runDefaultMemoryFlush(entry, overrides)).outcome).toBe("completed");

    // A reset keeps the session ID and restarts the count but rotates the lifecycle revision.
    const reset = { ...entry, lifecycleRevision: "incarnation-2" };
    await writeTestSessionStore(overrides.storePath, overrides.sessionKey, reset);
    expect((await runDefaultMemoryFlush(reset, overrides)).outcome).toBe("completed");

    const firstId = requireEmbeddedAgentCall(0).memoryFlushTools?.flushId;
    expect(firstId).toMatch(/^[a-f0-9-]{36}$/);
    expect(requireEmbeddedAgentCall(1).memoryFlushTools?.flushId).not.toBe(firstId);
  });

  it.each([
    { source: "owner direct", chatType: "direct", senderIsOwner: true, audience: "owner-private" },
    {
      source: "non-owner direct",
      chatType: "direct",
      senderIsOwner: false,
      audience: "conversation",
    },
    { source: "owner group", chatType: "group", senderIsOwner: true, audience: "conversation" },
  ] as const)(
    "resolves a post-turn maintenance flush audience from its $source source turn",
    async ({ chatType, senderIsOwner, audience }) => {
      registerToolsFlushPlan();
      const { entry, overrides } = await createToolsFlushFixture({ chatType });
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
      runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        await executePersistenceTool(params);
        return { payloads: [], meta: {} };
      });

      const result = await runDefaultMemoryFlush(entry, { ...overrides, followupRun: maintenance });

      expect(result.outcome).toBe("completed");
      expect(maintenance.run.senderIsOwner).toBe(false);
      expect(requireEmbeddedAgentCall(0).senderIsOwner).toBe(false);
      expect(requireEmbeddedAgentCall(0).memoryAudience?.kind).toBe(audience);
    },
  );

  it.each([
    { evidence: "none", outcome: "failed", kind: "failed" },
    { evidence: "lookup", outcome: "failed", kind: "failed" },
    { evidence: "tool", outcome: "completed", kind: "succeeded" },
    { evidence: "silent", outcome: "completed", kind: "succeeded" },
    { evidence: "visible-silent", outcome: "completed", kind: "succeeded" },
    { evidence: "earlier-silent", outcome: "failed", kind: "failed" },
  ])(
    "requires persistence evidence for tools flush: $evidence",
    async ({ evidence, outcome, kind }) => {
      registerToolsFlushPlan();
      const { entry, overrides } = await createToolsFlushFixture();
      runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        if (evidence === "tool") {
          await executePersistenceTool(params);
        } else if (evidence === "lookup") {
          await executeLookupTool(params);
        }
        return {
          payloads:
            evidence === "earlier-silent" ? [{ text: "NO_REPLY" }, { text: "Finished." }] : [],
          meta: {
            finalAssistantRawText:
              evidence === "silent"
                ? "NO_REPLY"
                : evidence === "visible-silent"
                  ? "<final>NO_REPLY</final>"
                  : "Finished.",
            finalAssistantVisibleText: evidence === "visible-silent" ? "NO_REPLY" : undefined,
          },
        };
      });

      const result = await runDefaultMemoryFlush(entry, overrides);

      expect(result.outcome).toBe(outcome);
      expect(loadSessionEntry(overrides)?.memoryFlush).toMatchObject({ kind });
    },
  );

  it("skips tools flush without a source memory audience", async () => {
    registerToolsFlushPlan();
    const { entry, overrides } = await createToolsFlushFixture({ chatType: undefined });

    expect((await runDefaultMemoryFlush(entry, overrides)).outcome).toBe("skipped");
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(memoryFlushDebugMock).toHaveBeenCalledWith(
      expect.stringContaining("no memory audience"),
      expect.objectContaining({ pluginId: "knowledge" }),
    );
  });

  it("warns and skips a tools plan contributed by a non-owner sidecar", async () => {
    registerToolsFlushPlan(true);
    const { entry, overrides } = await createToolsFlushFixture();

    expect((await runDefaultMemoryFlush(entry, overrides)).outcome).toBe("skipped");
    expect(runEmbeddedAgentEntryMock).not.toHaveBeenCalled();
    expect(memoryFlushWarnMock).toHaveBeenCalledWith(
      expect.stringContaining('plugin "memory-sidecar"'),
    );
  });

  it("treats unavailable persistence tools as a skip instead of spending a failure attempt", async () => {
    registerToolsFlushPlan();
    const { entry, overrides } = await createToolsFlushFixture();
    runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      assertMemoryFlushPersistenceToolAvailable([], params.memoryFlushTools);
      throw new Error("inference must not run");
    });

    expect((await runDefaultMemoryFlush(entry, overrides)).outcome).toBe("skipped");
    expect(loadSessionEntry(overrides)?.memoryFlush).toBeUndefined();
    expect(memoryFlushWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("knowledge_save_page"),
    );
  });
});
