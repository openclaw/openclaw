// Imported by agent.test.ts to keep its mocked suite in one Vitest module graph.
import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { registerSubagentCompletionToolHandoff } from "../subagent-completion-tool-handoff.js";
import { registerAgentSendEventTests } from "./agent.session-events.test-utils.js";
import { registerPluginSubagentToolForwardingTests } from "./agent.spawned-child.test-support.js";
import {
  getAgentTestMocks,
  operatorWriteCliClient,
  makeContext,
  type AgentHandlerArgs,
  type AgentParams,
  type AgentCommandCall,
  setDateOnlyFakeClockActive,
  expectRecordFields,
  expectSqliteSessionFileMarkerForEntry,
  mockCallArg,
  expectRespondError,
  mockMainSessionEntry,
  mockSuccessfulAgentCommand,
  buildExistingMainStoreEntry,
  setupNewYorkTimeConfig,
  resetTimeConfig,
  primeMainAgentRun,
  runMainAgentAndCaptureEntry,
  REAL_PNG,
  waitForAgentCommandCall,
  invokeAgent,
  describe0AfterEach0,
} from "./agent.test-harness.js";
import { getAgentTestStorePath } from "./agent.user-turn-recorder.test-support.js";

const mocks = getAgentTestMocks();

describe("gateway agent handler", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-gateway-agent-media-routing-");
  afterEach(describe0AfterEach0);

  it.each([
    {
      name: "SQLite transcript",
      sessionKey: "agent:main:telegram:group:stale-failed",
      sessionId: "stale-failed-session-id",
      configureTranscript: async () => {
        mocks.hasSessionTranscriptEventsSync.mockReturnValue(true);
        return {};
      },
      expectsSqlitePresence: true,
    },
    {
      name: "SQLite transcript marker",
      sessionKey: "agent:main:telegram:group:stale-failed-sqlite",
      sessionId: "stale-failed-sqlite-session-id",
      configureTranscript: async (params: { sessionId: string; storePath: string }) => {
        mocks.hasSessionTranscriptEventsSync.mockReturnValue(true);
        return { sessionFile: `sqlite:main:${params.sessionId}:${params.storePath}` };
      },
      expectsSqlitePresence: true,
    },
  ])("recovers a stale failed session when its $name exists", async (scenario) => {
    const now = Date.parse("2026-05-18T09:49:30.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    setDateOnlyFakeClockActive(true);
    vi.setSystemTime(now);

    const root = sessionDirs.make();
    const sessionsDir = `${root}/sessions`;
    const storePath = `${sessionsDir}/sessions.json`;
    await fs.mkdir(sessionsDir, { recursive: true });
    const transcriptFields = await scenario.configureTranscript({
      sessionId: scenario.sessionId,
      storePath,
    });
    const failedEntryWithStaleActivity = {
      sessionId: scenario.sessionId,
      ...transcriptFields,
      status: "failed",
      startedAt: now - 11 * 60_000,
      endedAt: now - 10 * 60_000,
      runtimeMs: 60_000,
      abortedLastRun: true,
      updatedAt: now - 10 * 60_000,
      sessionStartedAt: now - 20 * 60_000,
      lastInteractionAt: now - 10 * 60_000,
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: { session: { idleMinutes: 5 } },
      storePath,
      entry: failedEntryWithStaleActivity,
      canonicalKey: scenario.sessionKey,
    });
    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        [scenario.sessionKey]: { ...failedEntryWithStaleActivity },
      };
      const result = await updater(store);
      capturedEntry = result as Record<string, unknown>;
      return result;
    });
    mockSuccessfulAgentCommand();

    await invokeAgent({
      message: "recover stale failed",
      agentId: "main",
      sessionKey: scenario.sessionKey,
      idempotencyKey: `test-idem-${scenario.sessionId}`,
    } as AgentParams);

    const call = await waitForAgentCommandCall<{ sessionId?: string }>();
    expect(call.sessionId).toBe(scenario.sessionId);
    if (scenario.expectsSqlitePresence) {
      expect(mocks.hasSessionTranscriptEventsSync).toHaveBeenCalledWith({
        agentId: "main",
        sessionId: scenario.sessionId,
        sessionKey: scenario.sessionKey,
        storePath,
      });
    } else {
      expect(mocks.hasSessionTranscriptEventsSync).not.toHaveBeenCalled();
    }
    expect(capturedEntry?.sessionId).toBe(scenario.sessionId);
    expect(capturedEntry?.status).toBeUndefined();
    expect(capturedEntry?.startedAt).toBeUndefined();
    expect(capturedEntry?.endedAt).toBeUndefined();
    expect(capturedEntry?.runtimeMs).toBeUndefined();
    expect(capturedEntry?.abortedLastRun).toBeUndefined();
    expectSqliteSessionFileMarkerForEntry(capturedEntry);
  });

  it("recovers a failed session when its SQLite transcript rows exist", async () => {
    const now = Date.parse("2026-05-18T09:50:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    setDateOnlyFakeClockActive(true);
    vi.setSystemTime(now);

    const root = sessionDirs.make();
    const sessionsDir = `${root}/sessions`;
    await fs.mkdir(sessionsDir, { recursive: true });
    mocks.hasSessionTranscriptEventsSync.mockReturnValue(true);
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: `${sessionsDir}/sessions.json`,
      entry: {
        sessionId: "failed-present-session-id",
        status: "failed",
        startedAt: now - 1_000,
        endedAt: now,
        runtimeMs: 1_000,
        abortedLastRun: true,
        updatedAt: now,
        sessionStartedAt: now,
        lastInteractionAt: now,
      },
      canonicalKey: "agent:main:main",
    });

    const capturedEntry = await runMainAgentAndCaptureEntry("test-idem-failed-present-transcript");

    const call = await waitForAgentCommandCall<{ sessionId?: string }>();
    expect(call.sessionId).toBe("failed-present-session-id");
    expect(capturedEntry?.sessionId).toBe("failed-present-session-id");
    expect(capturedEntry?.status).toBeUndefined();
    expect(capturedEntry?.startedAt).toBeUndefined();
    expect(capturedEntry?.endedAt).toBeUndefined();
    expect(capturedEntry?.runtimeMs).toBeUndefined();
    expect(capturedEntry?.abortedLastRun).toBeUndefined();
    expectSqliteSessionFileMarkerForEntry(capturedEntry);
  });

  it("keeps stored group metadata when a trusted group session receives caller-supplied selectors", async () => {
    const sessionKey = "agent:main:slack:group:C123";
    const existingEntry = buildExistingMainStoreEntry({
      channel: "slack",
      groupId: "C123",
      groupChannel: "#trusted",
      space: "TTRUSTED",
    });
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: getAgentTestStorePath(),
      entry: existingEntry,
      canonicalKey: sessionKey,
    });

    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        [sessionKey]: { ...existingEntry },
      };
      const result = await updater(store);
      capturedEntry = result as Record<string, unknown>;
      return result;
    });

    mockSuccessfulAgentCommand();

    await invokeAgent(
      {
        message: "trusted group turn",
        agentId: "main",
        sessionKey,
        channel: "slack",
        groupId: "C123",
        groupChannel: "#forged-admin",
        groupSpace: "TFORGED",
        idempotencyKey: "trusted-group-forged-selectors",
      },
      { reqId: "trusted-group-forged-selectors" },
    );

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    expect(capturedEntry?.groupId).toBe("C123");
    expect(capturedEntry?.groupChannel).toBe("#trusted");
    expect(capturedEntry?.space).toBe("TTRUSTED");
    const callArgs = await waitForAgentCommandCall<{
      groupChannel?: string;
      groupSpace?: string;
      runContext?: { groupChannel?: string; groupSpace?: string };
    }>();
    expect(callArgs.groupChannel).toBe("#trusted");
    expect(callArgs.groupSpace).toBe("TTRUSTED");
    expect(callArgs.runContext?.groupChannel).toBe("#trusted");
    expect(callArgs.runContext?.groupSpace).toBe("TTRUSTED");
  });

  it("persists first-turn group selectors for a trusted new group session", async () => {
    const sessionKey = "agent:main:slack:group:C123";
    let capturedEntry: Record<string, unknown> | undefined;
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath: getAgentTestStorePath(),
      entry: capturedEntry,
      canonicalKey: sessionKey,
    }));

    const store: Record<string, unknown> = {};
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const result = await updater(store);
      capturedEntry = store[sessionKey] as Record<string, unknown>;
      return result;
    });

    mockSuccessfulAgentCommand();

    await invokeAgent(
      {
        message: "first trusted group turn",
        agentId: "main",
        sessionKey,
        channel: "slack",
        groupId: "C123",
        groupChannel: "#general",
        groupSpace: "TWORKSPACE",
        idempotencyKey: "trusted-group-first-turn-selectors",
      },
      { reqId: "trusted-group-first-turn-selectors" },
    );

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    expect(capturedEntry?.groupId).toBe("C123");
    expect(capturedEntry?.groupChannel).toBe("#general");
    expect(capturedEntry?.space).toBe("TWORKSPACE");
    const callArgs = await waitForAgentCommandCall<{
      groupChannel?: string;
      groupSpace?: string;
      runContext?: { groupChannel?: string; groupSpace?: string };
    }>();
    expect(callArgs.groupChannel).toBe("#general");
    expect(callArgs.groupSpace).toBe("TWORKSPACE");
    expect(callArgs.runContext?.groupChannel).toBe("#general");
    expect(callArgs.runContext?.groupSpace).toBe("TWORKSPACE");
  });

  it("tags newly-created plugin runtime sessions with the plugin owner", async () => {
    const sessionKey = "agent:main:dreaming-narrative-light-workspace-1";
    let capturedEntry: Record<string, unknown> | undefined;
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath: getAgentTestStorePath(),
      entry: capturedEntry,
      canonicalKey: sessionKey,
    }));

    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {};
      const result = await updater(store);
      capturedEntry = store[sessionKey] as Record<string, unknown>;
      return result;
    });

    mockSuccessfulAgentCommand();

    await invokeAgent(
      {
        message: "write a narrative",
        sessionKey,
        idempotencyKey: "plugin-runtime-owner",
      },
      {
        client: createSyntheticPluginRuntimeClient({ pluginRuntimeOwnerId: "memory-core" }),
      },
    );

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    expect(capturedEntry?.pluginOwnerId).toBe("memory-core");
  });

  registerPluginSubagentToolForwardingTests();

  it("forwards trusted delegated policy handoffs only from internal client metadata", async () => {
    primeMainAgentRun();
    const handoffId = registerSubagentCompletionToolHandoff({
      sourceSessionKey: "agent:main:subagent:child",
      sourceSessionId: "child-session-id",
      targetSessionKey: "agent:main:main",
      targetSessionId: "existing-session-id",
      idempotencyKey: "delegated-policy-handoff",
    });

    await invokeAgent(
      {
        message: "child completed",
        sessionKey: "agent:main:main",
        idempotencyKey: "delegated-policy-handoff",
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:subagent:child",
          sourceTool: "subagent_announce",
        },
        internalEvents: [
          {
            type: "task_completion",
            source: "subagent",
            childSessionKey: "agent:main:subagent:child",
            childSessionId: "child-session-id",
            announceType: "subagent task",
            taskLabel: "work",
            status: "ok",
            statusLabel: "completed",
            result: "child completed",
            replyInstruction: "Continue from this result.",
          },
        ],
      },
      {
        client: createSyntheticPluginRuntimeClient({
          delegatedToolPolicyHandoffId: handoffId,
        }),
      },
    );

    const call = await waitForAgentCommandCall<{
      onActiveModelSelected?: (selection: { provider: string; model: string }) => Promise<void>;
      trustedInternalHandoff?: {
        kind: string;
        sourceSessionKey: string;
        sourceSessionId?: string;
        targetSessionKey: string;
        targetSessionId: string;
        provider: string;
        model: string;
      };
    }>();
    const trustedInternalHandoff = expectDefined(
      call.trustedInternalHandoff,
      "trusted completion handoff test invariant",
    );
    await expectDefined(
      call.onActiveModelSelected,
      "model-selection callback test invariant",
    )({
      provider: "anthropic",
      model: "sonnet-4.6",
    });
    expect(call.trustedInternalHandoff).toBe(trustedInternalHandoff);
    expect(call.trustedInternalHandoff).toMatchObject({
      kind: "subagent-completion",
      sourceSessionKey: "agent:main:subagent:child",
      sourceSessionId: "child-session-id",
      targetSessionKey: "agent:main:main",
      targetSessionId: "existing-session-id",
      provider: "anthropic",
      model: "sonnet-4.6",
    });
  });

  it("does not claim stale pre-existing sessions for plugin runtime cleanup", async () => {
    const sessionKey = "agent:main:existing-user-session";
    const existingEntry = {
      sessionId: "stale-session",
      updatedAt: 1,
      pluginOwnerId: "other-plugin",
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: getAgentTestStorePath(),
      entry: existingEntry,
      canonicalKey: sessionKey,
    });

    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        [sessionKey]: { ...existingEntry },
      };
      const result = await updater(store);
      capturedEntry = store[sessionKey] as Record<string, unknown>;
      return result;
    });

    mockSuccessfulAgentCommand();

    await invokeAgent(
      {
        message: "write a narrative",
        sessionKey,
        idempotencyKey: "plugin-runtime-existing-owner",
      },
      {
        client: createSyntheticPluginRuntimeClient({ pluginRuntimeOwnerId: "memory-core" }),
      },
    );

    expect(capturedEntry?.pluginOwnerId).toBe("other-plugin");
  });

  it("forwards provider and model overrides for admin-scoped callers", async () => {
    primeMainAgentRun();

    await invokeAgent(
      {
        message: "test override",
        agentId: "main",
        sessionKey: "agent:main:main",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        idempotencyKey: "test-idem-model-override",
      },
      {
        reqId: "test-idem-model-override",
        client: operatorWriteCliClient(["operator.admin"]),
      },
    );

    expectRecordFields(await waitForAgentCommandCall(), {
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });

  it("forwards explicit ACP turn source markers", async () => {
    primeMainAgentRun();

    await invokeAgent(
      {
        message: "bootstrap ACP child",
        agentId: "main",
        sessionKey: "agent:main:main",
        acpTurnSource: "manual_spawn",
        idempotencyKey: "test-acp-turn-source",
      },
      { reqId: "test-acp-turn-source" },
    );

    expectRecordFields(await waitForAgentCommandCall(), {
      acpTurnSource: "manual_spawn",
    });
  });

  it.each([
    { name: "non-ACP session", sessionKey: "agent:main:main" },
    { name: "ACP-shaped session without metadata", sessionKey: "agent:main:acp:missing-meta" },
  ])("requires image understanding for a $name with acpTurnSource", async ({ sessionKey }) => {
    mocks.loadConfigReturn = {
      agents: { defaults: { model: { primary: "test/text-only" } } },
    };
    primeMainAgentRun({ cfg: mocks.loadConfigReturn });
    mocks.readAcpSessionMetaAsync.mockResolvedValue(undefined);
    const respond = vi.fn();
    const context = makeContext();
    context.loadGatewayModelCatalog = vi.fn<typeof context.loadGatewayModelCatalog>(async () => [
      { id: "text-only", name: "Synthetic text model", provider: "test", input: ["text"] },
    ]);
    const runId = `image-offload-${sessionKey}`;

    await invokeAgent(
      {
        message: "describe this image",
        agentId: "main",
        sessionKey,
        acpTurnSource: "manual_spawn",
        idempotencyKey: runId,
        attachments: [
          {
            type: "file",
            mimeType: "image/png",
            fileName: "test.png",
            content: REAL_PNG.toString("base64"),
          },
        ],
      },
      { context, respond, reqId: runId },
    );

    // A claimed ACP source cannot hand raw images to a text-only model.
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(respond).toHaveBeenLastCalledWith(
      false,
      expect.objectContaining({ status: "error" }),
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
        message: expect.stringContaining(
          "Configure agents.defaults.imageModel or tools.media.models",
        ),
      }),
      expect.objectContaining({ runId }),
    );
  });

  it("rejects provider and model overrides for write-scoped callers", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "test override",
        agentId: "main",
        sessionKey: "agent:main:main",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        idempotencyKey: "test-idem-model-override-write",
      },
      {
        reqId: "test-idem-model-override-write",
        client: operatorWriteCliClient(["operator.write"]),
        respond,
      },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expectRespondError(respond, {
      message: "provider/model overrides are not authorized for this caller.",
    });
  });

  it("forwards provider and model overrides when internal override authorization is set", async () => {
    primeMainAgentRun();

    await invokeAgent(
      {
        message: "test override",
        agentId: "main",
        sessionKey: "agent:main:main",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        idempotencyKey: "test-idem-model-override-internal",
      },
      {
        reqId: "test-idem-model-override-internal",
        client: {
          ...operatorWriteCliClient(["operator.write"]),
          internal: {
            allowModelOverride: true,
          },
        } as AgentHandlerArgs["client"],
      },
    );

    expectRecordFields(await waitForAgentCommandCall(), {
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });

  it("preserves cliSessionIds from existing session entry", async () => {
    const existingCliSessionIds = { "claude-cli": "abc-123-def" };
    const existingClaudeCliSessionId = "abc-123-def";

    mockMainSessionEntry({
      cliSessionIds: existingCliSessionIds,
      claudeCliSessionId: existingClaudeCliSessionId,
    });

    const capturedEntry = await runMainAgentAndCaptureEntry("test-idem");
    expect(capturedEntry.cliSessionIds).toEqual(existingCliSessionIds);
    expect(capturedEntry.claudeCliSessionId).toBe(existingClaudeCliSessionId);
  });

  // #5369: sessions.patch can write modelOverride to the session store between
  // when the agent handler reads its cached entry and when updateSessionStore
  // runs. The handler's loadSessionEntry may return the stale pre-patch entry
  // (no modelOverride), while the store-load inside updateSessionStore has the
  // fresh value. If the patch built from the stale entry carries modelOverride:
  // undefined, the merge {...fresh, ...patch} clobbers the fresh value.
  // Broader regression guard for the #5369 stale-writeback class: any field
  // that the patch blindly carries from the cached entry will clobber a fresh
  // concurrent write. The fix dropped all such fields from the patch; this
  // test ensures none get silently re-added. If a future change puts e.g.
  // `sendPolicy: entry?.sendPolicy` back into the patch, this test fails.
  it("preserves all fresh session fields when cached entry is stale (#5369 broader)", async () => {
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: getAgentTestStorePath(),
      entry: {
        sessionId: "subagent-session-id",
        updatedAt: Date.now() - 1000,
        // All fields below absent — stale pre-patch view
      },
      canonicalKey: "agent:main:subagent:test-broader",
    });
    const freshFields = {
      modelOverride: "qwen3-coder:30b",
      providerOverride: "ollama",
      sendPolicy: "allow",
      skillsSnapshot: { tools: ["bash"] },
      thinkingLevel: "high",
      fastMode: true,
      verboseLevel: "detailed",
      traceLevel: "info",
      reasoningLevel: "on",
      systemSent: true,
      spawnedWorkspaceDir: "/work/fresh",
      spawnDepth: 2,
      label: "fresh-label",
      spawnedBy: "agent:main:main",
      channel: "telegram",
      deliveryContext: {
        channel: "telegram",
        to: "12345",
        accountId: "acct-1",
        threadId: 42,
      },
      lastChannel: "telegram",
      lastTo: "12345",
      lastAccountId: "acct-1",
      lastThreadId: 42,
      cliSessionIds: { "claude-cli": "fresh-cli-id" },
      cliSessionBindings: { "claude-cli": { sessionId: "fresh-binding" } },
      claudeCliSessionId: "fresh-cli-id",
    };
    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const freshStore: Record<string, Record<string, unknown>> = {
        "agent:main:subagent:test-broader": {
          sessionId: "subagent-session-id",
          updatedAt: Date.now(),
          ...freshFields,
        },
      };
      const result = await updater(freshStore);
      capturedEntry = freshStore["agent:main:subagent:test-broader"];
      return result;
    });
    mockSuccessfulAgentCommand();
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:subagent:test-broader",
        idempotencyKey: "test-5369-broader",
      },
      { reqId: "broader-1" },
    );
    for (const [field, expected] of Object.entries(freshFields)) {
      expect(capturedEntry?.[field]).toEqual(expected);
    }
  });

  it("checks delivery sendPolicy against the fresh store entry (#5369)", async () => {
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: getAgentTestStorePath(),
      entry: {
        sessionId: "subagent-session-id",
        updatedAt: Date.now() - 1000,
        // sendPolicy absent — stale pre-patch view
      },
      canonicalKey: "agent:main:subagent:test-policy",
    });
    const freshUpdatedAt = Date.now();
    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const freshStore: Record<string, Record<string, unknown>> = {
        "agent:main:subagent:test-policy": {
          sessionId: "subagent-session-id",
          updatedAt: freshUpdatedAt,
          sendPolicy: "deny",
          channel: "telegram",
        },
      };
      const result = await updater(freshStore);
      capturedEntry = freshStore["agent:main:subagent:test-policy"];
      return result;
    });
    mocks.resolveSendPolicy.mockImplementation((args?: { entry?: { sendPolicy?: string } }) =>
      args?.entry?.sendPolicy === "deny" ? "deny" : "allow",
    );
    mocks.agentCommand.mockClear();
    mockSuccessfulAgentCommand();
    const respond = vi.fn();
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:subagent:test-policy",
        channel: "telegram",
        to: "99999",
        deliver: true,
        idempotencyKey: "test-5369-policy",
      },
      { reqId: "policy-1", respond },
    );
    expectRespondError(respond, { message: "send blocked by session policy" });
    const sendPolicyArgs = expectRecordFields(mockCallArg(mocks.resolveSendPolicy), {
      sessionKey: "agent:main:subagent:test-policy",
    });
    expectRecordFields(sendPolicyArgs.entry, { sendPolicy: "deny" });
    expectRecordFields(capturedEntry, {
      sessionId: "subagent-session-id",
      updatedAt: freshUpdatedAt,
      sendPolicy: "deny",
      channel: "telegram",
      deliveryContext: undefined,
      lastTo: undefined,
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("recovers terminal failed agent API sessions with SQLite transcript rows", async () => {
    const sessionId = "failed-agent-session";
    const root = sessionDirs.make();
    const sessionsDir = `${root}/sessions`;
    await fs.mkdir(sessionsDir, { recursive: true });
    mocks.hasSessionTranscriptEventsSync.mockReturnValue(true);
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: `${sessionsDir}/sessions.json`,
      entry: {
        sessionId,
        status: "failed",
        startedAt: 100,
        endedAt: 200,
        runtimeMs: 100,
        abortedLastRun: true,
        updatedAt: Date.now(),
      },
      canonicalKey: "agent:main:main",
    });

    const capturedEntry = await runMainAgentAndCaptureEntry("recover-terminal-agent-session");
    const call = await waitForAgentCommandCall();

    expect(call.sessionId).toBe(sessionId);
    expectRecordFields(capturedEntry, {
      sessionId,
      status: undefined,
      startedAt: undefined,
      endedAt: undefined,
      runtimeMs: undefined,
      abortedLastRun: undefined,
    });
  });

  it("does not restore a stale session id over a fresh store rotation (#5369)", async () => {
    mocks.resolveSessionLifecycleTimestamps.mockImplementation(
      ({ entry }: { entry?: { sessionId?: string; sessionStartedAt?: number } }) => ({
        sessionStartedAt: entry?.sessionId === "old-session-id" ? 123 : entry?.sessionStartedAt,
        lastInteractionAt: undefined,
      }),
    );
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: getAgentTestStorePath(),
      entry: {
        sessionId: "old-session-id",
        updatedAt: Date.now() - 1000,
      },
      canonicalKey: "agent:main:subagent:test-rotation",
    });
    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const freshStore: Record<string, Record<string, unknown>> = {
        "agent:main:subagent:test-rotation": {
          sessionId: "fresh-session-id",
          updatedAt: Date.now(),
          startedAt: 111,
          sessionFile: "/tmp/fresh-session.jsonl",
        },
      };
      const result = await updater(freshStore);
      capturedEntry = freshStore["agent:main:subagent:test-rotation"];
      return result;
    });
    mockSuccessfulAgentCommand();

    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:subagent:test-rotation",
        idempotencyKey: "test-5369-rotation",
      },
      { reqId: "rotation-1" },
    );

    expectRecordFields(capturedEntry, {
      sessionId: "fresh-session-id",
      status: undefined,
      startedAt: 111,
      sessionStartedAt: undefined,
    });
    expectSqliteSessionFileMarkerForEntry(capturedEntry);
  });

  // Upgrade-path self-heal: a legacy session entry may lack sessionStartedAt
  // because the field was added after the entry was first persisted. The
  // handler recovers it from the transcript JSONL header and writes it back,
  // but only when the fresh store still lacks the field — so a concurrent
  // writer that sets it cannot be clobbered (the #5369 stale-writeback class).
  it("self-heals missing sessionStartedAt from JSONL when fresh store also lacks it", async () => {
    // Use a value distinct from `now` but recent enough that
    // evaluateSessionFreshness — which also calls the mocked
    // resolveSessionLifecycleTimestamps — keeps this session fresh.
    const recoveredStartedAt = Date.now() - 5_000;
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: getAgentTestStorePath(),
      entry: {
        sessionId: "legacy-session-id",
        updatedAt: Date.now() - 1000,
        // sessionStartedAt absent — legacy schema
      },
      canonicalKey: "agent:main:subagent:legacy",
    });
    mocks.resolveSessionLifecycleTimestamps.mockReturnValue({
      sessionStartedAt: recoveredStartedAt,
      lastInteractionAt: undefined,
    });
    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const freshStore: Record<string, Record<string, unknown>> = {
        "agent:main:subagent:legacy": {
          sessionId: "legacy-session-id",
          updatedAt: Date.now(),
          // sessionStartedAt absent on disk too — self-heal should fire
        },
      };
      const result = await updater(freshStore);
      capturedEntry = freshStore["agent:main:subagent:legacy"];
      return result;
    });
    mockSuccessfulAgentCommand();
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:subagent:legacy",
        idempotencyKey: "test-selfheal-write",
      },
      { reqId: "selfheal-1" },
    );
    expect(capturedEntry?.sessionStartedAt).toBe(recoveredStartedAt);
  });

  it("does not clobber fresh sessionStartedAt with the recovered candidate", async () => {
    // See note in the prior test: keep both values recent so freshness
    // evaluation (which also reads the lifecycle mock) doesn't trip the
    // idle-reset path and turn this into an isNewSession path.
    const recoveredStartedAt = Date.now() - 5_000;
    const freshStartedAt = Date.now() - 2_500;
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: getAgentTestStorePath(),
      entry: {
        sessionId: "legacy-session-id",
        updatedAt: Date.now() - 1000,
        // sessionStartedAt absent in cached entry — would trigger recovery
      },
      canonicalKey: "agent:main:subagent:concurrent",
    });
    mocks.resolveSessionLifecycleTimestamps.mockReturnValue({
      sessionStartedAt: recoveredStartedAt,
      lastInteractionAt: undefined,
    });
    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const freshStore: Record<string, Record<string, unknown>> = {
        "agent:main:subagent:concurrent": {
          sessionId: "legacy-session-id",
          updatedAt: Date.now(),
          // Concurrent writer set sessionStartedAt between cache load and lock
          sessionStartedAt: freshStartedAt,
        },
      };
      const result = await updater(freshStore);
      capturedEntry = freshStore["agent:main:subagent:concurrent"];
      return result;
    });
    mockSuccessfulAgentCommand();
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:subagent:concurrent",
        idempotencyKey: "test-selfheal-noclobber",
      },
      { reqId: "selfheal-2" },
    );
    expect(capturedEntry?.sessionStartedAt).toBe(freshStartedAt);
  });

  registerAgentSendEventTests();

  it("passes the raw user message to agentCommand for LLM-boundary timestamping", async () => {
    setupNewYorkTimeConfig("2026-01-29T01:30:00.000Z");

    primeMainAgentRun({ cfg: mocks.loadConfigReturn });

    await invokeAgent(
      {
        message: "Is it the weekend?",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-timestamp-inject",
      },
      { reqId: "ts-1" },
    );

    const callArgs = await waitForAgentCommandCall<{ message?: string }>();
    expect(callArgs.message).toBe("Is it the weekend?");

    resetTimeConfig();
  });

  it("marks inter-session agent messages at the gateway boundary without timestamping them", async () => {
    setupNewYorkTimeConfig("2026-01-29T01:30:00.000Z");
    primeMainAgentRun({ cfg: mocks.loadConfigReturn });

    await invokeAgent(
      {
        message: "forwarded reply",
        agentId: "main",
        sessionKey: "agent:main:main",
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:discord:source",
          sourceTool: "sessions_send",
        },
        idempotencyKey: "test-inter-session-marker",
      },
      { reqId: "inter-session-marker" },
    );

    const callArgs = await waitForAgentCommandCall<
      AgentCommandCall & {
        message?: string;
        userTurnTranscriptRecorder?: {
          message?: unknown;
        };
      }
    >();
    expect(callArgs.message).toMatch(/^\[Inter-session message\]/);
    expect(callArgs.message).toContain("isUser=false");
    expect(callArgs.message).toContain("forwarded reply");
    expect(callArgs.message).not.toContain("[Wed 2026-01-28 20:30 EST]");
    expect(callArgs.userTurnTranscriptRecorder?.message).toMatchObject({
      role: "user",
      content: "forwarded reply",
      provenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:discord:source",
        sourceTool: "sessions_send",
      },
    });

    resetTimeConfig();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
