import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { Value } from "typebox/value";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { convertResponsesToolPayload } from "../../../packages/ai/src/providers/openai-responses-tools.js";
import { SessionsCreateParamsSchema } from "../../../packages/gateway-protocol/src/schema/sessions-create.js";
import { validateToolArguments } from "../../../packages/llm-core/src/validation.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { createReplyTurnParticipants } from "../../sessions/session-controller.tool-authority.js";
import {
  drainSessionStateForTest,
  useSessionStoreTempDirs,
} from "../../test-utils/session-state-cleanup.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import {
  expectRegisteredSubagentRun,
  supportedSpawnModelChoice,
} from "../subagents/spawn/subagent-spawn.test-helpers.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-visible-cloud-spawn-");

const hoisted = vi.hoisted(() => ({
  spawnSubagentDirectMock: vi.fn(),
  spawnAcpDirectMock: vi.fn(),
  prepareModelChoiceMock: vi.fn<typeof supportedSpawnModelChoice>(),
  runSubagentProgressMock: vi.fn(async () => {}),
}));
vi.mock("../subagents/spawn/subagent-spawn.runtime.js", () => ({
  prepareModelChoice: hoisted.prepareModelChoiceMock,
}));
vi.mock("../subagents/spawn/subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_CONTEXT_MODES: ["isolated", "fork"],
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  spawnSubagentDirect: (...args: unknown[]) => hoisted.spawnSubagentDirectMock(...args),
}));
vi.mock("../subagents/spawn/acp-spawn.js", () => ({
  spawnAcpDirect: (...args: unknown[]) => hoisted.spawnAcpDirectMock(...args),
}));
vi.mock("../subagents/registry/subagent-registry.js", () => ({
  registerSubagentRun: vi.fn(),
}));
vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: (name: string) => name === "subagent_progress",
    runSubagentProgress: hoisted.runSubagentProgressMock,
  }),
}));

let createSessionsSpawnTool: typeof import("./sessions-spawn-tool.js").createSessionsSpawnTool;
let acpRuntimeRegistry: typeof import("../../acp/runtime/registry.js");
const requireRecord = createRequireRecord("record", "expected-label");

async function withCloudGateway<T>(run: () => Promise<T>, localEmbedded = false): Promise<T> {
  const context = { localEmbedded } as GatewayRequestContext;
  return await withGatewayToolCallerIdentity(
    { agentId: "main", sessionKey: "agent:main:main", gatewayContextResolver: () => context },
    run,
  );
}

describe("visible session placement and authority", () => {
  beforeAll(async () => {
    ({ createSessionsSpawnTool } = await import("./sessions-spawn-tool.js"));
    acpRuntimeRegistry = await import("../../acp/runtime/registry.js");
  });
  beforeEach(() => {
    setRuntimeConfigSnapshot({});
    acpRuntimeRegistry.testing.resetAcpRuntimeBackendsForTests();
    hoisted.prepareModelChoiceMock.mockReset().mockImplementation(supportedSpawnModelChoice);
    hoisted.spawnSubagentDirectMock.mockReset();
    hoisted.spawnAcpDirectMock.mockReset();
    hoisted.runSubagentProgressMock.mockClear();
  });
  afterEach(async () => {
    await drainSessionStateForTest();
    clearRuntimeConfigSnapshot();
    acpRuntimeRegistry.testing.resetAcpRuntimeBackendsForTests();
  });

  it.each([
    { visible: undefined, placement: undefined },
    { visible: false, placement: { kind: "local" } },
  ])(
    "uses local execution through Responses conversion and hidden dispatch: %j",
    async ({ visible, placement }) => {
      const callGateway = vi.fn();
      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:dashboard:parent",
        workspaceDir: "/workspace/parent",
        callGateway,
        config: { tools: { swarm: true } },
      });
      const [wireTool] = convertResponsesToolPayload([tool], { strict: true });
      expect(wireTool?.strict).toBe(false);
      const parameters = requireRecord(wireTool?.parameters, "Responses parameters");
      expect(parameters.required).not.toContain("placement");
      // Exact synthetic campaign call; optional placement variants share the boundary.
      const request = {
        mode: "run",
        completionTarget: "parent",
        streamTo: "parent",
        task: "Independently verify this entire input.txt content: 'Synthetic coding fixture: 2 + 2 = 4.' Use ordinary integer arithmetic. State the computed sum and whether the stated equality is correct. All needed context is in this task. Do not use tools, inspect environment or credentials, create a checkout, or read or modify files. Answer directly.",
        user: "gateway-owner",
        taskName: "check-one",
        label: "Independent calculation check one",
        runtime: "subagent",
        agentId: "stress1",
        model: "openai/stress-primary",
        runTimeoutSeconds: 120,
        thinking: "off",
        cyberAccessProgram: "standard",
        cwd: "/var/folders/xn/p60r8bmd5nx8_fzvmcc85xwc0000gn/T/openclaw-restart-workspaces-vtpHBi/stress1",
        cleanup: "keep",
        expectsCompletionMessage: true,
        sandbox: "inherit",
        context: "isolated",
        lightContext: true,
        blind: false,
        fastMode: false,
        placement: { kind: "local" },
        visible: false,
        group: "",
        projectId: "",
        projectGitUrl: "",
        worktree: false,
        worktreeName: "check-one",
        worktreeBaseRef: "",
        attachments: [],
        attachAs: { mountPath: "" },
        resumeSessionId: "",
      };
      Object.assign(request, { visible, placement });
      expect(Value.Check(parameters, request)).toBe(true);
      const invalidPlacement = { ...request, placement: { kind: "local", profileId: "ignored" } };
      expect(Value.Check(parameters, invalidPlacement)).toBe(false);
      const args = validateToolArguments(tool, {
        type: "toolCall",
        id: "local-review",
        name: tool.name,
        arguments: request,
      });
      expect(args).toEqual(request);
      hoisted.spawnSubagentDirectMock.mockResolvedValue({
        status: "accepted",
        childSessionKey: "agent:main:subagent:review",
        runId: "local-review-run",
      });

      const participants = createReplyTurnParticipants({
        operatorAuthority: createAdmittedRunOperatorAuthority({
          profileId: request.user,
          scopes: ["operator.write"],
          assertCurrent: () => {},
        }),
      });
      const result = await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:dashboard:parent",
          personalToolParticipants: participants,
        },
        () => tool.execute("local-review", args),
      ).finally(() => participants.close());

      expect(result.details).toMatchObject({ status: "accepted", runId: "local-review-run" });
      expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledOnce();
      expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
        expect.objectContaining({
          task: request.task,
          cwd: request.cwd,
          mode: "run",
          completionTarget: "parent",
          expectsCompletionMessage: true,
          worktree: false,
          projectId: undefined,
          worktreeName: undefined,
          worktreeBaseRef: undefined,
        }),
        expect.objectContaining({
          agentSessionKey: "agent:main:dashboard:parent",
          workspaceDir: "/workspace/parent",
        }),
      );
      expect(callGateway).not.toHaveBeenCalled();
    },
  );

  it("routes explicit local placement to ACP without creating a cloud session", async () => {
    acpRuntimeRegistry.registerAcpRuntimeBackend({
      id: "placement-test",
      runtime: {
        ensureSession: vi.fn(() => Promise.reject(new Error("Unexpected ACP session creation"))),
        async *runTurn() {},
        cancel: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      },
    });
    hoisted.spawnAcpDirectMock.mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:reviewer:acp:local",
      runId: "local-acp-run",
    });
    const callGateway = vi.fn();
    const tool = createSessionsSpawnTool({ agentSessionKey: "agent:main:main", callGateway });
    const result = await tool.execute("local-acp", {
      task: "Review locally",
      runtime: "acp",
      agentId: "reviewer",
      cwd: "/workspace/review",
      mode: "run",
      placement: { kind: "local" },
    });
    expect(result.details).toMatchObject({ status: "accepted", runId: "local-acp-run" });
    expect(hoisted.spawnAcpDirectMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ task: "Review locally", cwd: "/workspace/review", mode: "run" }),
      expect.anything(),
    );
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });

  const deniedPlacements: Array<{
    name: string;
    args: Record<string, unknown>;
    error?: RegExp;
    embedded?: boolean;
  }> = [
    ...[false, true].map((embedded) => ({
      name: `unhosted (embedded: ${embedded})`,
      embedded,
      args: { visible: true, worktree: true, placement: { kind: "profile", profileId: "build" } },
    })),
    ...[
      { placement: { kind: "profile", profileId: "build" }, visible: false },
      { placement: { kind: "profile", profileId: "build" }, visible: true, worktree: false },
    ].map((args) => ({
      name: JSON.stringify(args),
      args,
      error:
        /^Cloud placement requires visible=true and worktree=true\. Corrected call: sessions_spawn\(/,
    })),
    {
      name: "local placement with a cloud selector",
      args: {
        placement: { kind: "local", profileId: "placeholder" },
        visible: true,
        worktree: true,
      },
      error: /Omit placement for local.*configured cloud profile/,
    },
  ];
  it.each(deniedPlacements)(
    "rejects $name before creating a child",
    async ({ args, error, embedded }) => {
      const callGateway = vi.fn();
      const tool = createSessionsSpawnTool({ callGateway, countActiveRuns: () => 0 });
      const invoke = () => tool.execute("invalid-cloud", { task: "inspect", ...args });
      if (error) {
        await expect(invoke()).rejects.toThrow(error);
      } else {
        const result = embedded ? await withCloudGateway(invoke, true) : await invoke();
        expect(result.details).toMatchObject({
          status: "forbidden",
          error: expect.stringContaining("live hosted Gateway"),
        });
      }
      expect(callGateway).not.toHaveBeenCalled();
      expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    "success",
    "dispatch-failed",
    "cancelled",
    "wrong-child",
    "send-failed",
    "registration-failed",
    "cancel-after-accept",
  ])("starts or retains the cloud child without a local fallback: %s", async (failure) => {
    const success = failure === "success";
    const os = "windows/wsl2";
    const task = success
      ? [
          "Run the platform tests and investigate any failures.",
          "Preserve the full task and report the relevant test evidence. ".repeat(30),
          "Include this final paragraph in the cloud worker assignment.",
        ].join("\n\n")
      : "Test remotely";
    const placement = { state: "active", ...(success ? { environmentId: "cloud-box" } : {}) };
    const dir = sessionDirs.make();
    const storePath = path.join(dir, "sessions.json");
    const key = "agent:main:dashboard:cloud-child";
    const controller = new AbortController();
    const callGateway = vi.fn(async (method: string, request: Record<string, unknown>) => {
      if (method === "sessions.create") {
        if (success) {
          Value.Assert(SessionsCreateParamsSchema, request);
        }
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: key, storePath },
          { sessionId: "cloud-child", updatedAt: 1 },
        );
        return { key, sessionId: "cloud-child", runStarted: false };
      }
      if (method === "sessions.dispatch") {
        if (failure === "dispatch-failed") {
          throw new Error("provider unavailable");
        }
        if (failure === "cancelled") {
          controller.abort(new Error("caller stopped"));
        }
        return {
          key,
          sessionId: failure === "wrong-child" ? "replacement" : "cloud-child",
          placement,
        };
      }
      if (method === "chat.abort") {
        return { aborted: true, runIds: [request.runId] };
      }
      if (failure === "cancel-after-accept") {
        controller.abort(new Error("parent stopped after acceptance"));
      }
      if (failure === "send-failed") {
        throw new Error("initial reply lost");
      }
      return { runId: "cloud-run", ...(success ? { status: "accepted" } : {}) };
    });
    const registerRun = vi.fn(async () => {
      if (failure === "registration-failed") {
        throw new Error("registration unavailable");
      }
    });
    const config: OpenClawConfig = {
      session: { store: storePath },
      agents: {
        ...(success
          ? { defaults: { subagents: { model: "mock-provider/child@child-profile" } } }
          : {}),
        entries: { main: {} },
      },
      cloudWorkers: { profiles: { build: { provider: "fixture", settings: {} } } },
    };
    setRuntimeConfigSnapshot(config);
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config,
      callGateway: callGateway as never,
      registerRun,
      countActiveRuns: () => 0,
    });
    const result = await withCloudGateway(() =>
      tool.execute(
        "cloud-failure",
        {
          task,
          visible: true,
          worktree: true,
          placement: {
            kind: "profile",
            profileId: "build",
            ...(success ? { os, machineClass: "tiny" } : {}),
          },
          ...(success ? { runTimeoutSeconds: 180 } : {}),
        },
        controller.signal,
      ),
    );
    if (success) {
      expect(callGateway.mock.calls.map(([method]) => method)).toEqual([
        "sessions.create",
        "sessions.dispatch",
        "agent",
      ]);
      expect(callGateway.mock.calls[0]?.[1]).toMatchObject({
        model: "mock-provider/child@child-profile",
        titleSource: task.slice(0, 1000),
      });
      expect(callGateway.mock.calls[0]?.[1]).not.toHaveProperty("task");
      expect(callGateway).toHaveBeenCalledWith(
        "sessions.dispatch",
        {
          key,
          profileId: "build",
          os,
          machineClass: "tiny",
        },
        expect.objectContaining({ timeoutMs: null }),
      );
      expect(callGateway).toHaveBeenCalledWith(
        "agent",
        expect.objectContaining({
          sessionKey: key,
          sessionId: "cloud-child",
          expectedExistingSessionId: "cloud-child",
          message: expect.stringContaining(task),
          timeout: 180,
          deliver: false,
          sessionEffects: "visible",
        }),
        expect.anything(),
      );
      expect(result.details).toMatchObject({
        status: "accepted",
        childSessionKey: key,
        runId: "cloud-run",
        placement,
      });
      expectRegisteredSubagentRun(registerRun, {
        runId: "cloud-run",
        childSessionKey: key,
        task,
      });
      return;
    }
    expect(result.details).toMatchObject({ status: "error", childSessionKey: key });
    const methods = callGateway.mock.calls.map(([method]) => method);
    expect(methods).not.toContain("sessions.delete");
    if (["dispatch-failed", "cancelled", "wrong-child"].includes(failure)) {
      expect(methods).not.toContain("agent");
      expect(result.details).toMatchObject({ initialTaskStatus: "not-sent" });
    }
    if (failure === "send-failed") {
      expect(result.details).toMatchObject({ initialTaskStatus: "unknown" });
    }
    if (["send-failed", "registration-failed", "cancel-after-accept"].includes(failure)) {
      expect(callGateway).toHaveBeenCalledWith(
        "chat.abort",
        {
          sessionKey: key,
          runId: failure === "send-failed" ? "visible-cloud-spawn:cloud-child" : "cloud-run",
        },
        expect.anything(),
      );
    }
    if (failure === "cancel-after-accept") {
      expect(result.details).toMatchObject({ runId: "cloud-run" });
      expect(registerRun).not.toHaveBeenCalled();
    }
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
  });
});
