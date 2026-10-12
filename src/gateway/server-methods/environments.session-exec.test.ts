import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ExecAsk, ExecSecurity, ExecApprovalsFile } from "../../infra/exec-approvals.js";
import type { WorkerWorkspaceCommand } from "../worker-environments/tunnel-contract.js";
import { environmentsSessionExecHandlers } from "./environments.session-exec.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  current: true,
  policy: { security: "full" as ExecSecurity, ask: "off" as ExecAsk, effectiveHost: "gateway" },
  approve: vi.fn(),
  capturedToolPolicy: true,
  ambient: true,
  assertToolAllowed: vi.fn(),
}));
vi.mock("./environments.session.js", () => ({
  resolveSessionEnvironmentCaller: () => ({
    identity: { sessionId: "conversation", sessionKey: "agent:main:test", agentId: "main" },
    assertCurrent: () => {
      if (!mocks.current) {
        throw new Error("Run authority closed");
      }
    },
  }),
}));
vi.mock("./sessions-shared.js", () => ({
  loadAccessorSessionEntryForGatewayTarget: () => ({ entry: { sessionId: "conversation" } }),
}));
// mock-isolation: This dispatch fixture injects policy resolution; canonical policy writes are covered by the exec-approval store tests.
vi.mock("../../agents/exec-defaults.js", () => ({
  prepareExecDefaults: () => ({
    kind: "needs-approvals",
    resolve: (file: ExecApprovalsFile) => ({ ...mocks.policy, ...file.defaults }),
  }),
}));
// mock-isolation: Prepared session classification is unrelated to this fixture's transport and effect checks.
vi.mock("../../agents/sandbox/runtime-status.js", () => ({
  resolveSandboxRuntimeStatus: () => ({}),
}));
// mock-isolation: The live reader is injected; worker publication and SQL-free reads have their owning store integration proof.
vi.mock("../../infra/exec-approvals-store.js", () => ({
  prepareExecApprovalsCurrentRead: async () => () => ({
    version: 1,
    defaults: { security: mocks.policy.security, ask: mocks.policy.ask },
  }),
}));
// mock-isolation: No database is opened by the injected policy reader.
vi.mock("../../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: () => ({}),
}));
vi.mock("./environments.session-exec-approval.js", () => ({
  approveSessionEnvironmentCommand: mocks.approve,
}));
vi.mock("../../agents/tools/gateway-caller-context.js", () => ({
  getGatewayToolCallerIdentity: () =>
    mocks.ambient
      ? {
          agentId: "main",
          sessionKey: "agent:main:test",
          operationalRunInstance: { instanceId: "exec-test-instance", runId: "exec-test-run" },
          ...(mocks.capturedToolPolicy ? { assertToolAllowed: mocks.assertToolAllowed } : {}),
        }
      : undefined,
}));

const binding = {
  sessionId: "conversation",
  sessionKey: "agent:main:test",
  agentId: "main",
  environmentId: "worker:preview",
  ownerEpoch: 3,
  generation: 1,
};
const result = {
  workspaceDir: "/workspace",
  stdout: "app ready",
  stderr: "",
  code: 0,
  signal: null,
  killed: false,
  termination: "exit",
};

function fixture(denied: string[] = [], runtimeAllow?: string[]) {
  const execute = vi.fn(async (_binding: unknown, command: WorkerWorkspaceCommand) => {
    command.assertCurrent?.();
    return result;
  });
  const respond = vi.fn();
  const options = {
    req: { type: "req", id: "exec-1", method: "environments.session.exec" },
    params: {},
    client:
      runtimeAllow === undefined
        ? null
        : {
            internal: {
              agentRuntimeIdentity: {
                sessionSpawnContext: {
                  inheritedToolPolicy: { version: 1, allow: runtimeAllow, deny: [] },
                },
              },
            },
          },
    respond,
    isWebchatConnect: () => true,
    context: {
      getRuntimeConfig: () => ({ tools: { deny: denied } }),
      workerEnvironmentService: {
        getSessionAttachment: () => binding,
        assertSessionAttachment: vi.fn(),
        execSessionAttachment: execute,
      },
    },
  } as unknown as GatewayRequestHandlerOptions;
  const call = async (params: Record<string, unknown>) => {
    await environmentsSessionExecHandlers["environments.session.exec"]!({ ...options, params });
    return respond.mock.calls.at(-1);
  };
  return { execute, call, respond };
}

beforeEach(() => {
  mocks.current = true;
  mocks.policy = { security: "full", ask: "off", effectiveHost: "gateway" };
  mocks.approve.mockReset();
  mocks.capturedToolPolicy = true;
  mocks.ambient = true;
  mocks.assertToolAllowed.mockReset();
});

describe("conversation environment execution RPC", () => {
  it.each([
    { allow: [], allowed: false },
    { allow: ["read"], allowed: false },
    { allow: ["exec"], allowed: true },
  ])("preserves the signed runtime's closed tool cap $allow", async ({ allow, allowed }) => {
    mocks.ambient = false;
    const { call, execute } = fixture([], allow);
    expect((await call({ argv: ["node", "app.js"] }))?.[0]).toBe(allowed);
    expect(execute).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });
  it("fails closed when the agent's captured tool authority is missing or denies execution", async () => {
    const { call, execute } = fixture();
    mocks.capturedToolPolicy = false;
    expect((await call({ argv: ["node", "app.js"] }))?.[0]).toBe(false);
    mocks.capturedToolPolicy = true;
    mocks.assertToolAllowed.mockImplementation(() => {
      throw new Error("Runtime tool cap denies exec");
    });
    expect((await call({ argv: ["node", "app.js"] }))?.[0]).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
  it("runs against the attached owner and returns its remote workspace result", async () => {
    const { call, execute } = fixture();
    const response = await call({ argv: ["node", "app.js"] });
    expect(response).toEqual([true, { environmentId: binding.environmentId, ...result }]);
    expect(execute).toHaveBeenCalledWith(
      binding,
      expect.objectContaining({ argv: ["node", "app.js"], transportRetry: "never" }),
    );
  });

  it.each([
    { params: { argv: ["node", "app.js"], environmentId: "worker:other" }, denied: [] },
    { params: { argv: ["node", "app.js"] }, denied: ["exec"] },
    { params: { action: "status", processId: "app" }, denied: ["process"] },
    { params: { action: "start", argv: ["node", "app.js"] }, denied: [] },
    { params: { action: "stop", processId: "app", argv: ["node"] }, denied: [] },
    { params: { argv: ["node"], sessionId: "invented-owner" }, denied: [] },
  ])(
    "rejects wrong targets, denied tools, and malformed controls without execution %#",
    async ({ params, denied }) => {
      const { call, execute } = fixture(denied);
      expect((await call(params))?.[0]).toBe(false);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each([
    { security: "deny", ask: "off" },
    { security: "allowlist", ask: "off" },
  ] as const)("does not turn $security/$ask policy into permission", async (policy) => {
    mocks.policy = { ...mocks.policy, ...policy };
    const { call, execute } = fixture();
    expect((await call({ argv: ["node", "app.js"] }))?.[0]).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it.each(["run", "policy"] as const)(
    "waits for approval and rechecks %s authority before dispatch",
    async (owner) => {
      mocks.policy = { ...mocks.policy, security: "allowlist", ask: "on-miss" };
      const decision = createDeferred();
      mocks.approve.mockReturnValue(decision.promise);
      const { call, execute } = fixture();
      const pending = call({ action: "start", argv: ["node", "app.js"], processId: "app" });
      await vi.waitFor(() => expect(mocks.approve).toHaveBeenCalledOnce());
      expect(execute).not.toHaveBeenCalled();
      if (owner === "run") {
        mocks.current = false;
      } else {
        mocks.policy = { ...mocks.policy, security: "deny" };
      }
      decision.resolve();
      expect((await pending)?.[0]).toBe(false);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("passes approved background operations to the owned process lifecycle", async () => {
    mocks.policy = { ...mocks.policy, security: "allowlist", ask: "on-miss" };
    const { call, execute } = fixture();
    expect((await call({ action: "start", argv: ["node", "app.js"], processId: "app" }))?.[0]).toBe(
      true,
    );
    expect(mocks.approve).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      binding,
      expect.objectContaining({ process: { action: "start", processId: "app" } }),
    );
  });

  it("dispatches the exact command presented for approval even if its request object changes", async () => {
    mocks.policy = { ...mocks.policy, security: "allowlist", ask: "on-miss" };
    const decision = createDeferred();
    mocks.approve.mockReturnValue(decision.promise);
    const { call, execute } = fixture();
    const params = { argv: ["node", "approved.js"], input: "approved stdin" };
    const pending = call(params);
    await vi.waitFor(() => expect(mocks.approve).toHaveBeenCalledOnce());
    params.argv[1] = "different.js";
    params.input = "different stdin";
    decision.resolve();
    expect((await pending)?.[0]).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      binding,
      expect.objectContaining({ argv: ["node", "approved.js"], input: "approved stdin" }),
    );
  });
});
