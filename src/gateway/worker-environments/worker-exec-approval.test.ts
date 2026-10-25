import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerExecApprovalResponseFrame } from "../../../packages/gateway-protocol/src/schema/worker-exec-approval.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resetProcessRegistryForTests } from "../../agents/bash-process-registry.test-support.js";
import type { ExecApprovalTransport } from "../../agents/exec-approval-transport.js";
import { prepareCoreToolPolicy } from "../../agents/prepared-tool-surface.js";
import * as completion from "../../agents/simple-completion-runtime.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../../agents/test-helpers/provider-model-fixture.js";
import { createToolSurfacePresentationForTest } from "../../agents/tool-surface-plan.test-support.js";
import { callGatewayTool } from "../../agents/tools/gateway.js";
import { saveExecApprovals } from "../../infra/exec-approvals-store.test-support.js";
import { createProcessSupervisor } from "../../process/supervisor/supervisor.js";
import type { ProcessSupervisor } from "../../process/supervisor/types.js";
import { createWorkerExecApprovalTransport } from "../../worker/worker-exec-approval.js";
import { createWorkerPlacementTools } from "../../worker/worker-placement-tools.js";
import { createPreparedTestApprovalManager } from "../exec-approval-manager.test-support.js";
import { createChatRunState } from "../server-chat-state.js";
import { createExecApprovalHandlers } from "../server-methods/exec-approval.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import { createContext } from "../server-plugin-in-process-dispatch.test-support.js";
import * as support from "./service.test-support.js";
import { createWorkerExecApprovalOwner } from "./worker-exec-approval.js";
import { createWorkerGatewayToolRuntime } from "./worker-gateway-tool-runtime.js";

const spawn = vi.hoisted(() => vi.fn<ProcessSupervisor["spawn"]>());
// mock-isolation: Record the real process boundary without replacing execution.
vi.mock("../../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn }),
}));
vi.mock("../../agents/tools/gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/tools/gateway.js")>()),
  callGatewayTool: vi.fn(() => {
    throw new Error("Worker exec attempted a local Gateway connection");
  }),
}));

support.setupWorkerEnvironmentServiceSuite();

const reviewerModel = makeProviderModelFixture({
  provider: "openrouter",
  id: "reviewer",
  api: "openai-completions",
  baseUrl: "https://example.invalid/v1",
});

function reviewerResponse() {
  return makeAgentAssistantMessage({
    api: reviewerModel.api,
    provider: reviewerModel.provider,
    model: reviewerModel.id,
    content: [
      {
        type: "text",
        text: JSON.stringify({ decision: "allow", risk: "low", rationale: "reviewer fixture" }),
      },
    ],
  });
}

describe.skipIf(process.platform === "win32")("worker exec approval boundary", () => {
  let supervisor: ReturnType<typeof createProcessSupervisor>;
  beforeEach(() => {
    for (const name of ["HOME", "USERPROFILE", "OPENCLAW_HOME", "ZDOTDIR"]) {
      vi.stubEnv(name, support.testState.root);
    }
    vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
    vi.stubEnv("PATH", "/usr/bin:/bin");
    vi.stubEnv("SHELL", "/bin/sh");
    vi.stubEnv("OPENCLAW_EXEC_SHELL_SNAPSHOT", "0");
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "on-miss", askFallback: "deny" },
      agents: {},
    });
    resetProcessRegistryForTests();
    supervisor = createProcessSupervisor();
    spawn.mockReset().mockImplementation((input) => supervisor.spawn(input));
    vi.mocked(callGatewayTool).mockClear();
    vi.spyOn(completion, "acquireSimpleCompletionModelForAgent").mockResolvedValue({
      selection: {
        provider: reviewerModel.provider,
        modelId: reviewerModel.id,
        agentDir: "/agent",
      },
      model: reviewerModel,
      auth: { apiKey: "synthetic-reviewer", mode: "api-key", source: "fixture" },
      [Symbol.asyncDispose]: async () => {},
    });
    vi.spyOn(completion, "completeWithPreparedSimpleCompletionModel").mockResolvedValue(
      reviewerResponse(),
    );
  });
  afterEach(async () => {
    await supervisor.shutdown();
    resetProcessRegistryForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function fixture(
    options: {
      alterResponse?: (frame: WorkerExecApprovalResponseFrame) => void;
      alterExecution?: (transport: ExecApprovalTransport) => ExecApprovalTransport;
      mode?: "auto" | "ask";
      gatewayContext?: GatewayRequestContext;
      turnSource?: Parameters<typeof createWorkerExecApprovalOwner>[0]["turnSource"];
    } = {},
  ) {
    const h = await support.placementHarness("exec-worker", "exec-session", {
      resolveGatewayContext: options.gatewayContext ? () => options.gatewayContext : undefined,
    });
    const exec = {
      host: "gateway",
      mode: options.mode ?? "auto",
      security: "allowlist",
      ask: options.mode === "ask" ? "always" : "on-miss",
    } as const;
    const policy = prepareCoreToolPolicy({});
    const runtime = createWorkerGatewayToolRuntime({
      assertCurrent: h.source.receiptAuthority,
      signal: new AbortController().signal,
      prepare: async () => ({
        tools: [],
        policy,
        presentation: createToolSurfacePresentationForTest(),
      }),
    });
    h.bindCapabilities({
      toolSurface: runtime,
      execApproval: createWorkerExecApprovalOwner({
        exec,
        config: {},
        agentId: "main",
        signal: new AbortController().signal,
        turnSource: options.turnSource,
        transcript: () => ({
          entries: [{ kind: "user", origin: "operator", text: "Print the worker marker." }],
          omittedEntries: 0,
          truncated: false,
        }),
      }),
    });
    const client = {
      captureExecApprovalAuthority: () => h.source.receiptAuthority,
      requestExecApproval: vi.fn(
        async (
          request: Parameters<typeof h.workerService.execApproval>[1],
        ): Promise<WorkerExecApprovalResponseFrame> => {
          const outcome = await h.workerService.execApproval(h.identity, request);
          const frame: WorkerExecApprovalResponseFrame = {
            type: "res",
            id: "exec-response",
            ok: true,
            payload: outcome.result,
          };
          options.alterResponse?.(frame);
          return frame;
        },
      ),
    };
    const tools = createWorkerPlacementTools({
      policy,
      cwd: support.testState.root,
      containmentRoot: support.testState.root,
      execAuthority: exec,
      agentId: "main",
      sessionKey: `worker:${h.identity.sessionId}`,
      sessionId: h.identity.sessionId!,
      runId: h.identity.runId!,
      createApprovalTransport: (toolCallId, signal) => {
        const transport = createWorkerExecApprovalTransport(client, toolCallId, signal);
        return options.alterExecution?.(transport) ?? transport;
      },
    });
    const tool = tools.find((entry) => entry.name === "exec");
    if (!tool) {
      throw new Error("Worker exec tool was not constructed");
    }
    return { ...h, tool, client };
  }

  it("reviews automatic worker exec on the Gateway and executes without a loopback call", async () => {
    const { tool, client } = await fixture();
    const result = await tool.execute("worker-print", { command: "/bin/echo worker-approved" });
    expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("worker-approved") }),
    ]);
    expect(completion.completeWithPreparedSimpleCompletionModel).toHaveBeenCalledOnce();
    expect(client.requestExecApproval).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        operation: "review",
        binding: expect.objectContaining({ command: "/bin/echo worker-approved" }),
      }),
    );
    const prompt = vi.mocked(completion.completeWithPreparedSimpleCompletionModel).mock
      .calls[0]?.[0].context.messages[0]?.content;
    expect(prompt).toContain('"command": "/bin/echo worker-approved"');
    expect(prompt).toContain(JSON.stringify(path.resolve(support.testState.root)));
    expect(spawn).toHaveBeenCalledOnce();
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it.each(["response", "execution"] as const)(
    "refuses a changed %s binding before spawn",
    async (tamper) => {
      const { tool } = await fixture(
        tamper === "response"
          ? {
              alterResponse: (frame) => {
                if (frame.ok) {
                  frame.payload.binding = "0".repeat(64);
                }
              },
            }
          : {
              alterExecution: (transport) => ({
                ...transport,
                assertExecution: (input) =>
                  transport.assertExecution({ ...input, command: "/bin/echo unapproved" }),
              }),
            },
      );
      await expect(
        tool.execute("worker-tamper", { command: "/bin/echo worker-approved" }),
      ).rejects.toThrow(/match.*Retry from a new worker turn/);
      expect(spawn).not.toHaveBeenCalled();
      expect(callGatewayTool).not.toHaveBeenCalled();
    },
  );

  it("refuses an automatic decision after the admitted turn closes during review", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    vi.mocked(completion.completeWithPreparedSimpleCompletionModel).mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return reviewerResponse();
    });
    const h = await fixture();
    const execution = h.tool.execute("worker-revoked", { command: "/bin/echo worker-approved" });
    await Promise.race([
      entered.promise,
      execution.then(() => {
        throw new Error("Worker finished without entering the Gateway reviewer");
      }),
    ]);
    h.releaseSource();
    release.resolve();
    await expect(execution).rejects.toThrow(
      "Worker exec approval was interrupted or returned no valid decision. Retry from a new worker turn.",
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("keeps human approval routing on the retained Gateway turn", async (testContext) => {
    let source: Awaited<ReturnType<typeof fixture>>["source"] | undefined;
    const approvals = await createPreparedTestApprovalManager(testContext, {
      validateAgentRuntimeDelegatedAuthority: () => {
        try {
          source?.receiptAuthority();
          return source !== undefined;
        } catch {
          return false;
        }
      },
    });
    await approvals.run(async () => {
      const handlers = createExecApprovalHandlers(approvals.manager);
      const context = createContext(
        [
          [
            "exec.approval.request",
            "operator.approvals",
            "exec",
            handlers["exec.approval.request"]!,
          ],
          [
            "exec.approval.waitDecision",
            "operator.approvals",
            "exec",
            handlers["exec.approval.waitDecision"]!,
          ],
        ],
        () => support.testState.config,
      );
      Object.assign(context, {
        broadcast: vi.fn(),
        hasExecApprovalClients: () => true,
        chatRunState: createChatRunState(),
        validateAgentRuntimeApprovalAuthority: () => true,
      });
      const turnSource = {
        turnSourceChannel: "telegram",
        turnSourceTo: "fixture-chat",
        turnSourceAccountId: "fixture-account",
        turnSourceThreadId: "fixture-thread",
      };
      const h = await fixture({ mode: "ask", gatewayContext: context, turnSource });
      source = h.source;
      const registration = await h.workerService.execApproval(h.identity, {
        operation: "request",
        id: "worker-routed-human",
        toolCallId: "worker-routed-exec",
        binding: {
          command: "echo routed",
          execCommand: "/bin/echo routed",
          cwd: support.testState.root,
          environment: "e".repeat(64),
          pty: false,
        },
      });
      expect(registration.result).toMatchObject({ id: "worker-routed-human" });
      const records = await approvals.manager.listPendingRecords();
      expect(records).toHaveLength(1);
      expect(records[0]?.request).toMatchObject({
        ...turnSource,
        command: "/bin/echo routed",
      });
      await approvals.manager.resolve("worker-routed-human", "deny", "operator");
      expect(callGatewayTool).not.toHaveBeenCalled();
    });
  });
});
