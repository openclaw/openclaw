import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { Value } from "typebox/value";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { convertResponsesToolPayload } from "../../../packages/ai/src/providers/openai-responses-tools.js";
import { validateToolArguments } from "../../../packages/llm-core/src/validation.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import {
  expectRegisteredSubagentRun,
  supportedSpawnModelChoice,
} from "../subagents/spawn/subagent-spawn.test-helpers.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";

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
    acpRuntimeRegistry.testing.resetAcpRuntimeBackendsForTests();
    hoisted.prepareModelChoiceMock.mockReset().mockImplementation(supportedSpawnModelChoice);
    hoisted.spawnSubagentDirectMock.mockReset();
    hoisted.spawnAcpDirectMock.mockReset();
    hoisted.runSubagentProgressMock.mockClear();
  });
  afterEach(() => acpRuntimeRegistry.testing.resetAcpRuntimeBackendsForTests());

  function mockCallArg(mock: unknown, callIndex: number, argIndex: number, label: string) {
    const calls = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls;
    if (!Array.isArray(calls)) {
      throw new Error(`expected ${label} mock calls`);
    }
    const call = calls[callIndex];
    if (!call) {
      throw new Error(`expected ${label} call ${callIndex + 1}`);
    }
    return requireRecord(call[argIndex], `${label} call ${callIndex + 1} arg ${argIndex + 1}`);
  }

  it.each(
    [undefined, false].flatMap((visible) => [
      { visible, placement: undefined },
      { visible, placement: { kind: "local" } },
    ]),
  )(
    "uses local execution through Responses conversion and hidden dispatch: %j",
    async ({ visible, placement }) => {
      const callGateway = vi.fn();
      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:dashboard:parent",
        workspaceDir: "/workspace/parent",
        callGateway,
      });
      const [wireTool] = convertResponsesToolPayload([tool], { strict: true });
      expect(wireTool?.strict).toBe(false);
      const parameters = requireRecord(wireTool?.parameters, "Responses parameters");
      expect(parameters.required).not.toContain("placement");
      const request = {
        task: "Review the local worktree",
        runtime: "subagent",
        ...(visible === undefined ? {} : { visible }),
        ...(placement === undefined ? {} : { placement }),
        worktree: false,
        mode: "run",
        cwd: "/workspace/review",
        completionTarget: "parent",
      };
      expect(Value.Check(parameters, request)).toBe(true);
      expect(
        Value.Check(parameters, {
          ...request,
          placement: { kind: "local", profileId: "ignored" },
        }),
      ).toBe(false);
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

      const result = await tool.execute("local-review", args);

      expect(result.details).toMatchObject({ status: "accepted", runId: "local-review-run" });
      expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledOnce();
      expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
        expect.objectContaining({
          task: request.task,
          cwd: request.cwd,
          mode: "run",
          completionTarget: "parent",
          expectsCompletionMessage: true,
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
        ensureSession: vi.fn(async () => ({
          sessionKey: "agent:reviewer:acp:local",
          backend: "placement-test",
          runtimeSessionName: "reviewer",
        })),
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

  it.each([false, true])(
    "rejects cloud creation outside a hosted Gateway (embedded: %s)",
    async (embedded) => {
      const callGateway = vi.fn();
      const tool = createSessionsSpawnTool({ callGateway, countActiveRuns: () => 0 });
      const invoke = () =>
        tool.execute("unhosted-cloud", {
          task: "test",
          visible: true,
          worktree: true,
          placement: { kind: "profile", profileId: "build" },
        });
      const result = embedded ? await withCloudGateway(invoke, true) : await invoke();
      expect(result.details).toMatchObject({
        status: "forbidden",
        error: expect.stringContaining("live hosted Gateway"),
      });
      expect(callGateway).not.toHaveBeenCalled();
    },
  );

  it.each(["linux", "windows/wsl2", "windows/normal", "macos"])(
    "starts a visible cloud child on %s only after placement is active",
    async (os) => {
      await withTestDir({ prefix: "openclaw-visible-cloud-spawn-" }, async (dir) => {
        const storePath = path.join(dir, "sessions.json");
        const key = "agent:main:dashboard:cloud-child";
        const placement = { state: "active", environmentId: "cloud-box" };
        const callGateway = vi.fn(async (method: string) => {
          if (method === "sessions.create") {
            await upsertSessionEntryCore(
              { agentId: "main", sessionKey: key, storePath },
              { sessionId: "cloud-child", updatedAt: 1 },
            );
            return { key, sessionId: "cloud-child", runStarted: false };
          }
          if (method === "sessions.dispatch") {
            return { key, sessionId: "cloud-child", placement };
          }
          return { runId: "cloud-run", status: "accepted" };
        });
        const registerRun = vi.fn();
        const tool = createSessionsSpawnTool({
          agentSessionKey: "agent:main:main",
          config: {
            session: { store: storePath },
            agents: {
              defaults: { subagents: { model: "mock-provider/child@child-profile" } },
              list: [{ id: "main" }],
            },
            cloudWorkers: { profiles: { build: { provider: "fixture", settings: {} } } },
          },
          callGateway: callGateway as never,
          registerRun,
          countActiveRuns: () => 0,
        });
        const result = await withCloudGateway(() =>
          tool.execute("cloud-spawn", {
            task: "Run the platform tests",
            visible: true,
            worktree: true,
            runTimeoutSeconds: 180,
            placement: { kind: "profile", profileId: "build", os, machineClass: "tiny" },
          }),
        );
        expect(callGateway.mock.calls.map(([method]) => method)).toEqual([
          "sessions.create",
          "sessions.dispatch",
          "agent",
        ]);
        expect(mockCallArg(callGateway, 0, 1, "sessions.create")).toMatchObject({
          model: "mock-provider/child@child-profile",
        });
        expect(mockCallArg(callGateway, 0, 1, "sessions.create")).not.toHaveProperty("task");
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
            message: expect.stringContaining("[Subagent Task]"),
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
        });
      });
    },
  );

  it.each([
    { placement: { kind: "profile", profileId: "build" }, visible: false },
    { placement: { kind: "profile", profileId: "build" }, visible: true, worktree: false },
    { placement: { kind: "profile", profileId: "build", os: "" }, visible: true, worktree: true },
    { placement: { kind: "device", deviceId: "other" }, visible: true, worktree: true },
    ...[
      null,
      {},
      { kind: "local", profileId: "placeholder" },
      { kind: "local", os: "linux" },
      { kind: "local", machineClass: "tiny" },
    ].map((placement) => ({ placement, visible: true, worktree: true })),
    ...["ignored", "placeholder"].map((selector) => ({
      visible: false,
      worktree: false,
      placement: { kind: "profile", profileId: selector, os: selector, machineClass: selector },
    })),
  ])("rejects invalid placement before creating a child: %j", async (args) => {
    const callGateway = vi.fn();
    const tool = createSessionsSpawnTool({ callGateway, countActiveRuns: () => 0 });
    await expect(tool.execute("invalid-cloud", { task: "inspect", ...args })).rejects.toThrow(
      /Omit placement for local.*configured cloud profile/,
    );
    expect(callGateway).not.toHaveBeenCalled();
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it.each([
    "dispatch-failed",
    "cancelled",
    "wrong-child",
    "send-failed",
    "registration-failed",
    "cancel-after-accept",
  ])("retains the cloud child without a local fallback when %s", async (failure) => {
    await withTestDir({ prefix: "openclaw-cloud-spawn-failure-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const key = "agent:main:dashboard:cloud-child";
      const controller = new AbortController();
      const callGateway = vi.fn(async (method: string, request: Record<string, unknown>) => {
        if (method === "sessions.create") {
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
            placement: { state: "active" },
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
        return { runId: "cloud-run" };
      });
      const registerRun = vi.fn(() => {
        if (failure === "registration-failed") {
          throw new Error("registration unavailable");
        }
      });
      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
        config: {
          session: { store: storePath },
          agents: { list: [{ id: "main" }] },
          cloudWorkers: { profiles: { build: { provider: "fixture", settings: {} } } },
        },
        callGateway: callGateway as never,
        registerRun,
        countActiveRuns: () => 0,
      });
      const result = await withCloudGateway(() =>
        tool.execute(
          "cloud-failure",
          {
            task: "Test remotely",
            visible: true,
            worktree: true,
            placement: { kind: "profile", profileId: "build" },
          },
          controller.signal,
        ),
      );
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
  // This shared creation policy remains the capability ceiling for cloud placement.
  it.each(
    (
      [
        { label: "default", mode: undefined },
        { label: "read-only", mode: "read-only" },
        { label: "guarded", mode: "guarded" },
        { label: "workspace", mode: "workspace" },
        { label: "full", mode: "full" },
      ] as const
    ).flatMap((scenario) => [
      { ...scenario, placement: undefined },
      { ...scenario, placement: { kind: "local" } },
    ]),
  )(
    "inherits the parent's $label permission mode in a visible local child ($placement)",
    async ({ mode, placement }) => {
      const callGateway = vi.fn(async (_method: string) => ({
        key: "agent:main:dashboard:child",
        runStarted: true,
        runId: "run-visible",
      }));
      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
        ...(mode ? { sessionPermissionPolicy: { mode, root: "/workspace/main" } } : {}),
        config: { agents: { list: [{ id: "main" }] } },
        callGateway: callGateway as never,
        registerRun: vi.fn(),
        countActiveRuns: () => 0,
      });

      await tool.execute("visible-permissions", {
        task: "inspect",
        visible: true,
        worktree: true,
        ...(placement === undefined ? {} : { placement }),
      });

      expect(callGateway.mock.calls.map(([method]) => method)).toEqual(["sessions.create"]);
      const createParams = mockCallArg(callGateway, 0, 1, "sessions.create");
      expect(createParams.worktree).toBe(true);
      expect(createParams.task).toEqual(expect.stringContaining("inspect"));
      expect(createParams).not.toHaveProperty("sessionRoot");
      if (mode) {
        expect(createParams.permissionMode).toBe(mode);
      } else {
        expect(createParams).not.toHaveProperty("permissionMode");
      }
    },
  );
});
