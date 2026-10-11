import "./sessions-spawn-tool.mocks.test-support.js";
import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { configureExecutionDecisionWorkSink } from "../../audit/execution-decision-work.js";
import type { ExecutionDecisionWork } from "../../audit/execution-decision-work.types.js";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { finalizeAgentToolAvailability } from "../agent-tool-availability.js";
import { readParentExecutionIdentity } from "../subagents/spawn/execution-identity-spawn-context.js";
import {
  expectRegisteredSubagentRun,
  supportedSpawnModelChoice,
} from "../subagents/spawn/subagent-spawn.test-helpers.js";
import {
  SWARM_CODE_MODE_IDEMPOTENCY_KEY,
  SWARM_CODE_MODE_REQUEST_FINGERPRINT,
} from "../subagents/swarm/swarm-code-mode.js";
import { createAgentsWaitTool } from "./agents-wait-tool.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { callInProcessGatewayTool } from "./in-process-gateway.js";
import { registerSessionsSpawnCompletionTests } from "./sessions-spawn-tool.completion.test-support.js";
import { registerSessionsSpawnInputTests } from "./sessions-spawn-tool.input.test-support.js";
import { registerSessionsSpawnVisibleCleanupTests } from "./sessions-spawn-tool.visible-cleanup.test-support.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-visible-spawn-");

const { hoisted } = await import("./sessions-spawn-tool.mocks.test-support.js");

let createSessionsSpawnTool: typeof import("./sessions-spawn-tool.js").createSessionsSpawnTool;
type SpawnOptions = NonNullable<Parameters<typeof createSessionsSpawnTool>[0]>;
let acpRuntimeRegistry: typeof import("../../acp/runtime/registry.js");

async function captureSessionDecisionWork<T>(run: () => Promise<T>): Promise<{
  result: T;
  work: ExecutionDecisionWork[];
  token: ReturnType<typeof createExecutionIdentityAdmissionToken>;
}> {
  const work: ExecutionDecisionWork[] = [];
  const clear = configureExecutionDecisionWorkSink((item) => {
    work.push(item);
    return true;
  });
  try {
    const token = createExecutionIdentityAdmissionToken("sessions-spawn-action", {
      contextId: "sessions-spawn-context",
      executionId: "sessions-spawn-execution",
    });
    const result = await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        executionIdentityToken: token,
        receiptAuthority: () => true,
      },
      run,
    );
    return { result, work, token };
  } finally {
    clear();
  }
}

describe("sessions_spawn tool", () => {
  beforeAll(async () => {
    ({ createSessionsSpawnTool } = await import("./sessions-spawn-tool.js"));
    acpRuntimeRegistry = await import("../../acp/runtime/registry.js");
  });

  beforeEach(() => {
    hoisted.prepareModelChoiceMock.mockReset().mockImplementation(supportedSpawnModelChoice);
    acpRuntimeRegistry.testing.resetAcpRuntimeBackendsForTests();
    hoisted.spawnSubagentDirectMock.mockReset().mockResolvedValue({
      status: "accepted",
      context: "isolated",
      childSessionKey: "agent:main:subagent:1",
      runId: "run-subagent",
    });
    hoisted.spawnAcpDirectMock.mockReset().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:codex:acp:1",
      runId: "run-acp",
    });
    hoisted.registerSubagentRunMock.mockReset();
    hoisted.inProcessCreationMock.mockReset();
    hoisted.runSubagentProgressMock.mockClear();
  });

  function registerAcpBackendForTest(healthy = true) {
    acpRuntimeRegistry.registerAcpRuntimeBackend({
      id: "acpx",
      healthy: () => healthy,
      runtime: {
        ensureSession: vi.fn(async () => ({
          sessionKey: "agent:codex:acp:1",
          backend: "acpx",
          runtimeSessionName: "codex",
        })),
        async *runTurn() {},
        cancel: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      },
    });
  }

  const requireRecord = createRequireRecord("record", "expected-label");

  function mockCallArg(mock: unknown, callIndex: number, argIndex: number, label: string) {
    const calls = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls;
    return requireRecord(calls?.[callIndex]?.[argIndex], `${label} argument ${argIndex}`);
  }

  const visibleCreated = {
    key: "agent:main:dashboard:child",
    runStarted: true,
    runId: "run-visible",
  };

  function mockGateway(response?: Record<string, unknown>) {
    const gateway = { call: callInProcessGatewayTool };
    const mock = vi.spyOn(gateway, "call");
    if (response) {
      mock.mockResolvedValue(response);
    } else {
      mock.mockRejectedValue(new Error("Unexpected Gateway call"));
    }
    return gateway.call;
  }

  function makeTool(options: SpawnOptions = {}) {
    return createSessionsSpawnTool({ agentSessionKey: "agent:main:main", ...options });
  }

  function makeVisibleTool(options: SpawnOptions = {}) {
    return makeTool({
      config: { agents: { entries: { main: {} } } },
      registerRun: vi.fn(),
      countActiveRuns: () => 0,
      ...options,
    });
  }

  registerSessionsSpawnCompletionTests({
    createTool: (options) => createSessionsSpawnTool(options),
    registerAcpBackendForTest,
    mocks: hoisted,
    mockCallArg,
  });

  registerSessionsSpawnInputTests({
    createTool: makeTool,
    registerAcpBackendForTest,
    mockGateway,
    mockCallArg,
    mocks: hoisted,
  });

  it("hides and rejects swarm parameters while tools.swarm is disabled", async () => {
    const tool = makeTool({
      config: { tools: { swarm: false } },
    });
    const schema = tool.parameters as { properties?: Record<string, unknown> };

    expect(schema.properties?.collect).toBeUndefined();
    expect(schema.properties?.outputSchema).toBeUndefined();
    expect(schema.properties?.fastMode).toBeUndefined();
    expect(schema.properties?.groupId).toBeUndefined();
    await expect(tool.execute("disabled", { task: "collect", collect: true })).rejects.toThrow(
      "tools.swarm.enabled=true",
    );
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("requires collector children to delegate only through collect mode", async () => {
    const tool = makeTool({
      agentSessionKey: "agent:worker:subagent:collector",
      swarmCollector: true,
      config: { tools: { swarm: true } },
    });

    finalizeAgentToolAvailability([tool, createAgentsWaitTool({})]);
    await expect(tool.execute("normal-child", { task: "ask for approval" })).rejects.toThrow(
      "requires collect=true",
    );
    const { work } = await captureSessionDecisionWork(
      async () => await tool.execute("collector-child", { task: "collect safely", collect: true }),
    );

    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledOnce();
    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({ collect: true }),
      expect.any(Object),
    );
    expect(work[0]?.receipt).toMatchObject({
      action: { family: "session", operation: "create" },
      decision: { outcome: "allowed", reasonCode: "session_create_committed" },
      enforcement: { coverageState: "attribution-only" },
    });
  });

  it("forwards collector parameters, identity, and host-only replay metadata", async () => {
    const tool = makeTool({ requesterRunId: "parent-run" });
    finalizeAgentToolAvailability([tool, createAgentsWaitTool({})]);
    const input: Record<PropertyKey, unknown> = {
      task: "collect",
      collect: true,
      outputSchema: { type: "object", required: ["answer"] },
      fastMode: "auto",
      groupId: "swarm:custom",
    };
    Object.defineProperty(input, SWARM_CODE_MODE_IDEMPOTENCY_KEY, { value: "cm-restart:bridge:1" });
    Object.defineProperty(input, SWARM_CODE_MODE_REQUEST_FINGERPRINT, { value: "sha256:request" });
    await tool.execute("collector", input);
    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        collect: true,
        outputSchema: { type: "object", required: ["answer"] },
        fastMode: "auto",
        groupId: "swarm:custom",
        expectsCompletionMessage: false,
        completionTarget: undefined,
        swarmLaunchReplayKey: "cm-restart:bridge:1",
        swarmLaunchRequestFingerprint: "sha256:request",
      }),
      expect.objectContaining({ requesterRunId: "parent-run" }),
    );
  });

  it("creates a visible worktree fork and registers its current completion destination", async () => {
    const dir = sessionDirs.make();
    const callGateway = mockGateway(visibleCreated);
    const registerRun = vi.fn();
    const tool = makeVisibleTool({
      requesterTurnRunId: "run-requester-visible-worktree",
      agentChannel: "slack",
      agentTo: "channel:C-stale",
      agentThreadId: "stale-thread",
      currentMessagingTarget: "channel:C-current",
      currentChannelId: "C-native",
      currentThreadTs: "current-thread",
      config: {
        session: { store: path.join(dir, "sessions.json") },
        agents: { defaults: { subagents: { model: "openai/gpt-5.4", runTimeoutSeconds: 120 } } },
      },
      callGateway,
      registerRun,
    });
    const worktree = {
      cwd: dir,
      worktree: true,
      worktreeName: "issue-review",
      worktreeBaseRef: "main",
    };
    const { result, work } = await captureSessionDecisionWork(() =>
      tool.execute("visible", {
        ...worktree,
        task: "inspect issue",
        label: "Issue review",
        group: "Beta feedback",
        model: "anthropic/claude-sonnet-4-6",
        context: "fork",
        visible: true,
        cleanup: "delete",
      }),
    );
    expect(result.details).toMatchObject({
      status: "accepted",
      childSessionKey: visibleCreated.key,
      runId: "run-visible",
      cleanup: "keep",
    });
    expect(callGateway).toHaveBeenCalledWith("sessions.create", {
      ...worktree,
      agentId: "main",
      label: "Issue review",
      category: "Beta feedback",
      model: "anthropic/claude-sonnet-4-6",
      task: expect.stringContaining("inspect issue"),
      timeoutMs: 120000,
      parentSessionKey: "agent:main:main",
      spawnDepth: 1,
      fork: true,
    });
    expectRegisteredSubagentRun(registerRun, {
      runId: "run-visible",
      requesterTurnRunId: "run-requester-visible-worktree",
      childSessionKey: visibleCreated.key,
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: "slack", to: "channel:C-current", threadId: "current-thread" },
      cleanup: "keep",
      runTimeoutSeconds: 120,
      expectsCompletionMessage: true,
      spawnMode: "run",
    });
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({
      receipt: {
        action: { family: "session", operation: "fork" },
        decision: { outcome: "allowed", reasonCode: "session_fork_committed" },
        enforcement: { coverageState: "attribution-only" },
      },
      refs: { target: { namespace: "session", value: '["main","agent:main:dashboard:child"]' } },
    });
  });

  it("creates an ungrouped visible session with empty staging hints", async () => {
    const callGateway = mockGateway(visibleCreated);
    const tool = makeVisibleTool({
      callGateway,
    });

    const result = await tool.execute("visible-ungrouped", {
      task: "inspect issue",
      visible: true,
      group: " \t\n ",
      mode: "run",
      attachments: [],
      attachAs: { mountPath: " \t\n " },
    });

    expect(result.details).toMatchObject({ status: "accepted", runId: "run-visible" });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(callGateway).toHaveBeenCalledWith(
      "sessions.create",
      expect.not.objectContaining({ category: expect.anything() }),
    );
  });

  it.each(["external", "allowed", "unstructured"] as const)(
    "only translates a structured admin denial for an external cwd: %s",
    async (scenario) => {
      await withTestDir({ prefix: "openclaw-visible-cwd-" }, async (workspace) => {
        const cwd = scenario === "allowed" ? workspace : path.dirname(workspace);
        const error =
          scenario === "unstructured"
            ? new Error("missing scope: operator.admin")
            : new GatewayClientRequestError({
                code: "FORBIDDEN",
                message: "permission denied",
                details: {
                  code: "MISSING_SCOPE",
                  missingScope: "operator.admin",
                  requiredScopes: ["operator.admin"],
                },
              });
        const callGateway = mockGateway();
        vi.mocked(callGateway).mockRejectedValue(error);
        const tool = makeVisibleTool({
          callGateway,
          config: { agents: { entries: { main: { workspace } } } },
        });
        const result = tool.execute("visible-cwd", {
          task: "inspect",
          cwd,
          visible: true,
          worktree: true,
        });
        if (scenario === "external") {
          expect((await result).details).toMatchObject({
            status: "forbidden",
            error: `Visible session cwd "${cwd}" is outside configured agent workspaces and requires operator.admin. Omit cwd to use the target agent workspace, or select a registered project with projectId or a GitHub repository with projectGitUrl. Do not substitute the synchronous \`openclaw agent\` CLI for a persistent visible session.`,
          });
        } else {
          await expect(result).rejects.toBe(error);
        }
        expect(callGateway).toHaveBeenCalledOnce();
      });
    },
  );

  it("rejects a visible spawn before creation when the exact parent incarnation changed", async () => {
    const dir = sessionDirs.make();
    const storePath = path.join(dir, "sessions.json");
    const parentSessionKey = "agent:main:main";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: parentSessionKey, storePath },
      { sessionId: "replacement-parent", updatedAt: 2 },
    );
    const callGateway = mockGateway();
    const tool = makeVisibleTool({
      agentSessionKey: parentSessionKey,
      expectedParentSessionId: "original-parent",
      config: {
        session: { store: storePath },
        agents: { entries: { main: {} } },
      },
      callGateway,
    });

    await expect(
      tool.execute("visible-stale-parent", { task: "inspect", visible: true }),
    ).rejects.toThrow(`Session "${parentSessionKey}" changed after access was granted.`);
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("allows an explicit zero visible timeout to disable the configured default", async () => {
    const callGateway = mockGateway(visibleCreated);
    const registerRun = vi.fn();
    const tool = makeVisibleTool({
      callGateway,
      registerRun,
      config: {
        agents: { defaults: { timeoutSeconds: 180, subagents: { runTimeoutSeconds: 120 } } },
      },
    });
    const result = await tool.execute("visible-timeout", {
      task: "inspect issue",
      visible: true,
      runTimeoutSeconds: 0,
    });
    expect(result.details).toMatchObject({ status: "accepted", runId: "run-visible" });
    expect(callGateway).toHaveBeenCalledWith(
      "sessions.create",
      expect.objectContaining({ timeoutMs: 0 }),
    );
    expectRegisteredSubagentRun(registerRun, { runId: "run-visible", runTimeoutSeconds: 0 });
  });

  it.each([
    {
      target: "reviewer",
      configuredModel: undefined,
      requesterModel: { provider: "openai", model: "gpt-5.6-sol" },
      expectedModel: "anthropic/claude-sonnet-4-6",
      inherits: false,
    },
    {
      target: "main",
      configuredModel: "openai/gpt-5.6-luna@preferred",
      requesterModel: { provider: "openai", model: "gpt-5.6-sol" },
      expectedModel: "openai/gpt-5.6-luna@preferred",
      inherits: false,
    },
    {
      target: "main",
      configuredModel: undefined,
      requesterModel: { provider: "custom", model: "custom/model" },
      expectedModel: "custom/custom/model",
      inherits: true,
    },
  ])(
    "selects $expectedModel for visible $target work",
    async ({ target, configuredModel, requesterModel, expectedModel, inherits }) => {
      const callGateway = hoisted.inProcessCreationMock.mockResolvedValue({
        ...visibleCreated,
        key: `agent:${target}:dashboard:child`,
      });
      const tool = makeVisibleTool({
        requesterModel,
        config: {
          agents: {
            defaults: { subagents: { allowAgents: ["main", "reviewer"] } },
            entries: {
              main: { subagents: { model: configuredModel } },
              reviewer: { subagents: { model: "anthropic/claude-sonnet-4-6" } },
            },
          },
        },
      });
      const result = await tool.execute("visible-model", {
        task: "review patch",
        agentId: target,
        visible: true,
      });
      expect(result.details).toMatchObject({ status: "accepted" });
      expect(callGateway).toHaveBeenCalledWith(
        "sessions.create",
        expect.objectContaining({
          agentId: target,
          model: expectedModel,
          parentSessionKey: "agent:main:main",
          spawnDepth: 1,
        }),
        expect.objectContaining({
          via: "spawn",
          requesterSessionKey: "agent:main:main",
          spawnModelAutoSelection: { model: expectedModel, hasFallbackOrigin: true },
        }),
        undefined,
      );
      expect(mockCallArg(callGateway, 0, 1, "sessions.create")).not.toHaveProperty("fork");
      const creation = mockCallArg(callGateway, 0, 2, "sessions.create");
      if (inherits) {
        expect(creation).toMatchObject({ resolvedModel: requesterModel });
      } else {
        expect(creation).not.toHaveProperty("resolvedModel");
      }
    },
  );

  it("rejects cross-agent visible transcript forks", async () => {
    const callGateway = mockGateway();
    const tool = makeVisibleTool({
      config: {
        agents: {
          defaults: { subagents: { allowAgents: ["reviewer"] } },
          entries: { main: {}, reviewer: {} },
        },
      },
      callGateway,
    });

    const result = await tool.execute("visible-cross-agent-fork", {
      task: "review patch",
      agentId: "reviewer",
      context: "fork",
      visible: true,
    });

    expect(result.details).toMatchObject({
      status: "error",
      error:
        'context="fork" currently requires the same target agent as the requester; use context="isolated" for cross-agent spawns.',
    });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "malformed agent ID",
      agentId: "Agent not found: reviewer",
      requireAgentId: false,
      expected: "Invalid agentId",
    },
    {
      name: "missing required agent ID",
      agentId: undefined,
      requireAgentId: true,
      expected: "sessions_spawn requires explicit agentId",
    },
  ])("keeps visible $name recovery independent of filtered tools", async (testCase) => {
    const callGateway = mockGateway();
    const tool = makeVisibleTool({
      config: {
        agents: {
          defaults: { subagents: { requireAgentId: testCase.requireAgentId } },
          entries: { main: {} },
        },
      },
      callGateway,
    });

    const result = await tool.execute("visible-invalid-agent", {
      task: "inspect issue",
      visible: true,
      ...(testCase.agentId ? { agentId: testCase.agentId } : {}),
    });

    const details = requireRecord(result.details, "visible spawn failure");
    expect(details.error).toContain(testCase.expected);
    expect(details.error).not.toContain("agents_list");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each([false, true])("enforces sandbox workspace containment (inside=%s)", async (inside) => {
    await withTestDir({ prefix: "openclaw-visible-sandbox-cwd-" }, async (dir) => {
      const workspace = path.join(dir, "workspace");
      const cwd = inside ? path.join(workspace, "packages", "app") : path.join(dir, "outside");
      const callGateway = mockGateway();
      if (inside) {
        vi.mocked(callGateway).mockResolvedValue(visibleCreated);
      }
      const tool = makeVisibleTool({
        callGateway,
        config: {
          agents: { defaults: { sandbox: { mode: "all" } }, entries: { main: { workspace } } },
        },
      });
      const result = await tool.execute("visible-sandbox-cwd", {
        task: "inspect",
        cwd,
        visible: true,
      });
      if (inside) {
        expect(result.details).toMatchObject({
          status: "accepted",
          owner: { type: "agent", id: "main" },
        });
        expect(result.details).not.toHaveProperty("sessionUrl");
        expect(callGateway).toHaveBeenCalledWith(
          "sessions.create",
          expect.objectContaining({ cwd }),
        );
      } else {
        expect(result.details).toMatchObject({
          status: "forbidden",
          error:
            "cwd override is not supported outside the target agent workspace for sandboxed visible session runs",
        });
        expect(callGateway).not.toHaveBeenCalled();
      }
    });
  });

  it("blocks unsandboxed visible targets for a sandboxed caller runtime", async () => {
    const callGateway = mockGateway();
    const tool = makeVisibleTool({
      sandboxed: true,
      callGateway,
    });

    const result = await tool.execute("visible-sandboxed", { task: "inspect", visible: true });

    expect(result.details).toMatchObject({
      status: "forbidden",
      error: "Sandboxed sessions cannot spawn unsandboxed sessions.",
    });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each(["inherit"] as const)(
    "admits a required parent's visible child with sandbox=%s while agent sandboxing is off",
    async (sandbox) => {
      const dir = sessionDirs.make();
      const storePath = path.join(dir, "sessions.json");
      const parentSessionKey = "agent:main:main";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: parentSessionKey, storePath },
        {
          sessionId: "required-parent",
          updatedAt: 1,
          createdVia: "operator",
          createdActor: { type: "human", source: "profile", id: "guest-profile" },
          sandbox: "required",
        },
      );
      hoisted.inProcessCreationMock.mockResolvedValue({
        key: "agent:main:dashboard:required-child",
        runStarted: true,
        runId: "required-visible-run",
      });
      const tool = makeVisibleTool({
        agentSessionKey: parentSessionKey,
        config: {
          session: { store: storePath },
          agents: {
            defaults: { sandbox: { mode: "off" } },
            entries: { main: { workspace: dir } },
          },
        },
      });

      const result = await tool.execute("required-visible-spawn", {
        task: "inspect the project in an isolated child",
        visible: true,
        sandbox,
      });

      expect(result.details).toMatchObject({
        status: "accepted",
        childSessionKey: "agent:main:dashboard:required-child",
      });
      expect(hoisted.inProcessCreationMock).toHaveBeenCalledWith(
        "sessions.create",
        expect.objectContaining({ parentSessionKey }),
        expect.objectContaining({ requesterSessionKey: parentSessionKey }),
        undefined,
      );
    },
  );

  it("applies the global requester's sandbox policy to visible children", async () => {
    const callGateway = mockGateway();
    const tool = makeVisibleTool({
      agentSessionKey: "global",
      requesterAgentIdOverride: "research",
      callGateway,
      config: {
        session: { scope: "global" },
        agents: {
          ownership: "explicit",
          entries: {
            research: { sandbox: { mode: "all" }, subagents: { allowAgents: ["worker"] } },
            worker: {},
          },
        },
      },
    });
    const result = await tool.execute("global-visible", {
      task: "inspect",
      visible: true,
      agentId: "worker",
    });
    expect(result.details).toMatchObject({ status: "forbidden" });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("reserves visible child capacity before session creation", async () => {
    const pending = createDeferred<typeof visibleCreated>();
    const started = createDeferred();
    const callGateway = mockGateway();
    vi.mocked(callGateway).mockImplementation(async () => {
      started.resolve();
      return await pending.promise;
    });
    const tool = makeVisibleTool({
      callGateway,
      config: { agents: { defaults: { subagents: { maxChildrenPerAgent: 1 } } } },
    });
    const first = tool.execute("first", { task: "first", visible: true });
    await started.promise;
    const second = await tool.execute("second", { task: "second", visible: true });
    expect(second.details).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("max active children"),
    });
    expect(callGateway).toHaveBeenCalledOnce();
    pending.resolve(visibleCreated);
    await expect(first).resolves.toMatchObject({ details: { status: "accepted" } });
  });

  registerSessionsSpawnVisibleCleanupTests({
    createTool: (options) => createSessionsSpawnTool(options),
  });

  it("applies spawn depth limits to visible dashboard descendants", async () => {
    const dir = sessionDirs.make();
    const storePath = path.join(dir, "sessions.json");
    const childKey = "agent:main:dashboard:child";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:main", storePath },
      { sessionId: "root", updatedAt: 1 },
    );
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: childKey, storePath },
      { sessionId: "child", updatedAt: 1, spawnDepth: 1, parentSessionKey: "agent:main:main" },
    );
    const callGateway = mockGateway();
    const spawn = (maxSpawnDepth: number) =>
      makeVisibleTool({
        agentSessionKey: childKey,
        callGateway,
        config: {
          session: { store: storePath },
          agents: { defaults: { subagents: { maxSpawnDepth } } },
        },
      }).execute("nested", { task: "inspect", visible: true });
    expect((await spawn(1)).details).toMatchObject({ status: "forbidden" });
    expect(callGateway).not.toHaveBeenCalled();
    vi.mocked(callGateway).mockResolvedValue({
      ...visibleCreated,
      key: "agent:main:dashboard:grandchild",
      runId: "run-grandchild",
    });
    expect((await spawn(2)).details).toMatchObject({
      status: "accepted",
      childSessionKey: "agent:main:dashboard:grandchild",
      runId: "run-grandchild",
    });
    expect(callGateway).toHaveBeenCalledWith(
      "sessions.create",
      expect.objectContaining({
        parentSessionKey: childKey,
        spawnDepth: 2,
        task: expect.stringContaining("inspect"),
      }),
    );
  });

  it("dispatches a hidden managed-worktree child with caller identity, policy, and private completion", async () => {
    const caller: SpawnOptions = {
      agentSessionKey: "agent:main:telegram:default:direct:456",
      completionOwnerKey: "agent:main:main",
      requesterThinkingLevel: "ultra",
      agentChannel: "telegram",
      agentAccountId: "default",
      agentTo: "telegram:direct:456",
      workspaceDir: "/parent/workspace",
      inheritedToolAllowlist: ["sessions_spawn", "read"],
      inheritedToolDenylist: ["exec"],
    };
    const request = {
      task: "build feature",
      taskName: "review_subagents-v2",
      agentId: "main",
      thinking: "medium",
      projectId: "example-project",
      worktree: true,
      worktreeName: "api-review",
      worktreeBaseRef: "origin/main",
      mode: "run",
      completionTarget: "parent",
      lightContext: true,
    };
    const tool = makeTool(structuredClone(caller));
    const { result, token } = await captureSessionDecisionWork(() =>
      tool.execute("native", {
        ...request,
        model: "default",
        run_timeout_seconds: 0,
        group: "   ",
        workspaceDir: "/tmp/attempted-override",
        resumeSessionId: "acp-only",
        streamTo: "parent",
      }),
    );
    expect(result.details).toMatchObject({
      status: "accepted",
      childSessionKey: "agent:main:subagent:1",
      runId: "run-subagent",
    });
    expect(result.details).not.toHaveProperty("role");
    const args = mockCallArg(hoisted.spawnSubagentDirectMock, 0, 0, "native");
    expect(args).toMatchObject({
      ...request,
      model: undefined,
      runTimeoutSeconds: 0,
      cleanup: "keep",
      expectsCompletionMessage: true,
    });
    expect(args).not.toHaveProperty("resumeSessionId");
    expect(args).not.toHaveProperty("streamTo");
    const context = mockCallArg(hoisted.spawnSubagentDirectMock, 0, 1, "native");
    expect(context).toMatchObject(caller);
    expect(readParentExecutionIdentity(context)).toBe(token);
    expect(JSON.stringify(tool.parameters)).not.toContain("parentExecutionIdentityToken");
    expect(JSON.stringify(result.details)).not.toMatch(
      /sessions-spawn-context|sessions-spawn-execution/,
    );
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
  });

  it.each([
    ["Bad-Name", "Invalid taskName"],
    ["last", "Reserved subagent targets"],
  ])("rejects taskName %s before spawning", async (taskName, error) => {
    const result = await makeTool().execute("invalid-name", { task: "review", taskName });
    expect(result.details).toMatchObject({
      status: "error",
      error: expect.stringContaining(error),
    });
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("dispatches ACP with the caller's identity, policy, resume, and completion context", async () => {
    registerAcpBackendForTest();
    const caller: SpawnOptions = {
      agentSessionKey: "agent:main:telegram:default:direct:456",
      completionOwnerKey: "agent:main:main",
      requesterAgentIdOverride: "main",
      agentChannel: "discord",
      agentAccountId: "default",
      agentTo: "channel:123",
      agentThreadId: "456",
      currentMessagingTarget: "channel:source",
      currentChannelId: "source-native",
      currentMessageId: "message-789",
      inheritedToolAllowlist: [
        "apply_patch",
        "edit",
        "exec",
        "process",
        "read",
        "sessions_spawn",
        "write",
      ],
      inheritedToolDenylist: ["custom_control_tool"],
    };
    const tool = makeTool({
      ...structuredClone(caller),
      config: { session: { threadBindings: { spawnSessions: true } } },
    });
    expect(tool.parameters).toMatchObject({
      properties: {
        runtime: { enum: ["subagent", "acp"] },
        mode: { enum: ["run", "session"] },
        thread: { type: "boolean" },
      },
    });
    const request = {
      task: "investigate",
      agentId: "codex",
      cwd: "/workspace",
      thread: true,
      mode: "session",
      streamTo: "parent",
      resumeSessionId: "prior-session",
      runTimeoutSeconds: 45,
    };
    const { result, work, token } = await captureSessionDecisionWork(() =>
      tool.execute("acp", { runtime: "acp", ...request }),
    );
    expect(result.details).toMatchObject({
      status: "accepted",
      childSessionKey: "agent:codex:acp:1",
      runId: "run-acp",
    });
    expect(hoisted.spawnAcpDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({ ...request, cleanup: "keep", expectsCompletionMessage: true }),
      expect.objectContaining(caller),
    );
    expect(readParentExecutionIdentity(mockCallArg(hoisted.spawnAcpDirectMock, 0, 1, "ACP"))).toBe(
      token,
    );
    expect(JSON.stringify(tool.parameters)).not.toContain("parentExecutionIdentityToken");
    expect(JSON.stringify(result.details)).not.toMatch(
      /sessions-spawn-context|sessions-spawn-execution/,
    );
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({
      receipt: {
        action: { family: "session", operation: "create" },
        decision: { outcome: "allowed", reasonCode: "session_create_committed" },
        enforcement: { coverageState: "attribution-only" },
      },
      refs: { target: { namespace: "session", value: '["codex","agent:codex:acp:1"]' } },
    });
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
    expect(hoisted.runSubagentProgressMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ inheritedToolDenylist: ["exec"] }, "requester denies exec"],
    [{ inheritedToolDenylist: ["group:fs"] }, "requester denies apply_patch"],
    [{ inheritedToolDenylist: ["exec*"] }, "requester denies exec"],
    [
      { inheritedToolAllowlist: ["sessions_spawn", "custom_plugin_tool"] },
      "requester does not allow apply_patch",
    ],
  ] satisfies Array<[SpawnOptions, string]>)(
    "rejects ACP when the inherited policy is incompatible: %j",
    async (policy, error) => {
      registerAcpBackendForTest();
      const result = await makeTool(policy).execute("acp-policy", {
        runtime: "acp",
        task: "inspect",
        agentId: "codex",
      });
      expect(result.details).toMatchObject({
        status: "forbidden",
        role: "codex",
        error: expect.stringContaining(error),
      });
      expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "sandboxed requester",
      true,
      { agentSessionKey: "agent:main:subagent:parent", sandboxed: true },
      "sandboxed sessions",
    ],
    ["missing backend", undefined, {}, "no ACP runtime backend is loaded"],
    ["unhealthy backend", false, {}, "no ACP runtime backend is loaded"],
    ["disabled policy", true, { config: { acp: { enabled: false } } }, "ACP is disabled by policy"],
  ] satisfies Array<[string, boolean | undefined, SpawnOptions, string]>)(
    "hides ACP affordances and rejects stale calls for %s",
    async (_scenario, healthy, options, error) => {
      if (healthy !== undefined) {
        registerAcpBackendForTest(healthy);
      }
      const tool = makeTool(options);
      const schema = requireRecord(tool.parameters, "schema");
      const properties = requireRecord(schema.properties, "properties");
      expect(properties.runtime).toMatchObject({ enum: ["subagent"] });
      expect(properties).not.toHaveProperty("resumeSessionId");
      expect(properties).not.toHaveProperty("streamTo");

      const result = await tool.execute("call-unavailable-acp", {
        runtime: "acp",
        task: "investigate",
        agentId: "codex",
      });
      expect(result.details).toMatchObject({
        status: "error",
        role: "codex",
        error: expect.stringContaining(error),
      });
      expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
      expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "disabled",
      policy: {},
      mimeType: "image/png",
      content: "png",
      status: "forbidden",
      error: "attachments are disabled",
    },
    {
      name: "non-image",
      policy: { enabled: true },
      mimeType: "text/plain",
      content: "hello",
      status: "error",
      error: "attachments_unsupported_for_acp",
    },
    {
      name: "oversized",
      policy: { enabled: true, maxFiles: 1, maxFileBytes: 4, maxTotalBytes: 4 },
      mimeType: "image/png",
      content: "too large",
      status: "error",
      error: "attachments_file_bytes_exceeded",
    },
  ])(
    "rejects $name ACP attachments before dispatch",
    async ({ policy, mimeType, content, status, error }) => {
      registerAcpBackendForTest();
      const result = await makeTool({
        config: { tools: { sessions_spawn: { attachments: policy } } },
      }).execute("acp-attachment", {
        runtime: "acp",
        task: "inspect",
        attachments: [{ name: "input", content, encoding: "utf8", mimeType }],
      });
      expect(result.details).toMatchObject({ status, error: expect.stringContaining(error) });
      expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
      expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    },
  );

  it("forwards ACP image bytes without exposing the formatting filename", async () => {
    registerAcpBackendForTest();
    const imageBase64 = Buffer.from("png-bytes").toString("base64");
    const tool = makeTool({
      config: {
        tools: {
          sessions_spawn: {
            attachments: {
              enabled: true,
              maxFiles: 1,
              maxFileBytes: 32,
              maxTotalBytes: 32,
            },
          },
        },
      },
    });
    const schema = requireRecord(tool.parameters, "schema");
    const properties = requireRecord(schema.properties, "properties");
    const attachments = requireRecord(properties.attachments, "attachments");
    const items = requireRecord(attachments.items, "items");
    const fields = requireRecord(items.properties, "attachment properties");
    expect(fields.content).toMatchObject({ type: "string" });
    expect(fields.content).not.toHaveProperty("maxLength");
    const result = await tool.execute("acp-image", {
      runtime: "acp",
      task: "describe the image",
      attachments: [
        {
          name: "photo\u202E.png",
          content: imageBase64,
          encoding: "base64",
          mimeType: "image/png",
        },
      ],
    });
    expect(result.details).toMatchObject({ status: "accepted" });
    expect(hoisted.spawnAcpDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [{ mediaType: "image/png", data: imageBase64 }] }),
      expect.anything(),
    );
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("rejects an unsupported visible model before creation or registration", async () => {
    hoisted.prepareModelChoiceMock.mockResolvedValue({
      kind: "unavailable",
      error: "Unknown model: xai/nonexistent-native-fixture",
    });
    const callGateway = mockGateway();
    const registerRun = vi.fn();
    const result = await makeVisibleTool({ callGateway, registerRun }).execute(
      "unsupported-model",
      {
        task: "inspect",
        model: "xai/nonexistent-native-fixture",
        visible: true,
      },
    );
    expect(result.details).toMatchObject({
      status: "error",
      error: expect.stringContaining("Unknown model"),
    });
    expect(callGateway).not.toHaveBeenCalled();
    expect(registerRun).not.toHaveBeenCalled();
    expect(hoisted.prepareModelChoiceMock).toHaveBeenCalledWith(
      expect.objectContaining({ raw: "xai/nonexistent-native-fixture", source: "override" }),
    );
  });

  it.each([
    {
      actor: { type: "human", id: "profile-vito" },
      identity: undefined,
      owner: { type: "human", id: "profile-vito" },
    },
    {
      actor: { type: "agent", id: "main" },
      identity: { name: "Roboclaw" },
      owner: { type: "agent", id: "main", label: "Roboclaw" },
    },
  ])("reports the stored visible owner $owner", async ({ actor, identity, owner }) => {
    hoisted.prepareModelChoiceMock.mockResolvedValue({
      kind: "automatic",
      ref: { provider: "mock-provider", model: "primary" },
    });
    const callGateway = mockGateway({ ...visibleCreated, entry: { owner: { actor } } });
    const tool = makeVisibleTool({
      callGateway,
      config: {
        agents: {
          defaults: { model: "mock-provider/primary" },
          entries: { main: { identity } },
        },
      },
    });
    const result = await tool.execute("owned-visible", { task: "inspect", visible: true });
    expect(result.details).toMatchObject({ status: "accepted", owner });
  });

  it("reports every unsupported visible parameter in one error", async () => {
    await expect(
      makeTool().execute("visible-unsupported", {
        task: "inspect",
        runtime: "acp",
        thread: true,
        mode: "session",
        lightContext: true,
        attachments: [{ name: "note.txt", content: "hello" }],
        attachAs: { mountPath: "inputs" },
        visible: true,
      }),
    ).rejects.toThrow(
      'Parameters unavailable with visible=true: runtime: supports runtime="subagent" only; thread: visible sessions route to the dashboard, not a channel thread; mode: visible sessions are persistent dashboard sessions; lightContext: bootstrap staging is not wired to the sessions.create path; attachments: attachment staging is not wired to the sessions.create path; attachAs: attachment staging is not wired to the sessions.create path',
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
