// A manual run starts with the caller's authority, but its tools stay bounded by the stored job.
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenClawCodingTools } from "../../agents/agent-tools.js";
import { applyEmbeddedAttemptToolsAllow } from "../../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { AUTOMATIONS_TOOL_NAME } from "../../agents/tools/automations-tool-name.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createGatewayMethodRegistry } from "../../gateway/methods/registry.js";
import { captureGatewayOperatorRunAuthority } from "../../gateway/operator-run-authority.js";
import { createScheduledGatewayRunner } from "../../gateway/scheduled-run-gateway-context.js";
import { cronHandlers } from "../../gateway/server-methods/cron.js";
import {
  cfg,
  createCronFixture,
  installRequesterCronAuthorityTestHooks,
  stateDir,
} from "../../gateway/server-methods/requester-cron-authority.test-support.js";
import type { GatewayRequestHandlerOptions } from "../../gateway/server-methods/types.js";
import { dispatchGatewayMethodInProcessRaw } from "../../gateway/server-plugin-in-process-dispatch.js";
import { createOperatorClient } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { getPluginToolMeta } from "../../plugins/tool-metadata.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { CronService, type CronEvent } from "../service.js";
import { createNoopLogger } from "../service.test-harness.js";
import {
  ensureAgentWorkspaceMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronDeliveryPlanMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
installRequesterCronAuthorityTestHooks();

beforeEach(() => {
  resetRunCronIsolatedAgentTurnHarness();
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  ensureAgentWorkspaceMock.mockImplementation(async ({ dir }: { dir: string }) => ({ dir }));
  resolveCronDeliveryPlanMock.mockReturnValue({ requested: false, mode: "none" });
  mockRunCronFallbackPassthrough();
});

afterEach(() => {
  runEmbeddedAgentMock.mockReset();
});

describe("manual run tool authority after the initiating invocation closes", () => {
  it.each<{ name: string; toolsAllow: string[]; withdraw?: "disable" | "remove" }>([
    { name: "allowed tool reaches its handler", toolsAllow: [AUTOMATIONS_TOOL_NAME] },
    { name: "tool outside the stored allowlist is absent", toolsAllow: ["read"] },
    {
      name: "disabling the job rejects the pending tool call",
      toolsAllow: [AUTOMATIONS_TOOL_NAME],
      withdraw: "disable",
    },
    {
      name: "removing the job rejects the pending tool call",
      toolsAllow: [AUTOMATIONS_TOOL_NAME],
      withdraw: "remove",
    },
  ])("$name", async ({ toolsAllow, withdraw }) => {
    const config: OpenClawConfig = {
      ...cfg,
      agents: {
        defaults: { skipBootstrap: true, workspace: stateDir },
        entries: { main: { workspace: stateDir } },
      },
      tools: { allow: [AUTOMATIONS_TOOL_NAME, "read"] },
    };
    setRuntimeConfigSnapshot(config);
    const fixture = createCronFixture(undefined, config);
    const { context } = fixture;
    context.resolveGatewayContext = () => context;
    // The real cron.list handler is the tool's final effect; the spy only counts calls.
    const listHandler = vi.fn((options: GatewayRequestHandlerOptions) =>
      expectDefined(cronHandlers["cron.list"], "cron.list")(options),
    );
    context.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry([
        {
          name: "cron.add",
          scope: "operator.admin",
          owner: { kind: "core", area: "cron" },
          handler: expectDefined(cronHandlers["cron.add"], "cron.add"),
        },
        {
          name: "cron.run",
          scope: "operator.write",
          owner: { kind: "core", area: "cron" },
          handler: expectDefined(cronHandlers["cron.run"], "cron.run"),
        },
        {
          name: "cron.list",
          scope: "operator.read",
          owner: { kind: "core", area: "cron" },
          handler: listHandler,
        },
      ]);
    const toolsReady = createDeferredCore();
    const continueTool = createDeferredCore();
    const finished = createDeferredCore<CronEvent>();
    let offeredTools: string[] = [];
    let toolResult: unknown;
    let toolError: string | undefined;
    // The model is controlled. Admission, stored tool policy, tool construction and dispatch are real.
    runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentParams) => {
      const admitted = await expectDefined(params.preparedRunAdmission, "run admission").admit(
        "gateway",
        params.runId,
      );
      const caller = createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: admitted,
        agentId: "main",
        sessionKey: params.sessionKey,
      });
      return withGatewayToolCallerIdentity(caller, async () => {
        const constructed = createOpenClawCodingTools({
          config: params.config,
          agentId: "main",
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          runId: params.runId,
          operationalRunInstance: admitted.operationalRunInstance,
          workspaceDir: params.workspaceDir,
          cwd: params.cwd,
          abortSignal: params.abortSignal,
          runtimeToolAllowlist: params.toolsAllow,
          scheduledToolPolicy: params.scheduledToolPolicy,
          toolConstructionPlan: {
            includeBaseCodingTools: true,
            includeShellTools: false,
            includeChannelTools: false,
            includeOpenClawTools: true,
            includePluginTools: false,
          },
        });
        // The embedded attempt applies the run allowlist after construction.
        const tools = applyEmbeddedAttemptToolsAllow(constructed, params.toolsAllow, {
          toolMeta: getPluginToolMeta,
        });
        offeredTools = tools.map((tool) => tool.name);
        toolsReady.resolve();
        await continueTool.promise;
        const automations = tools.find((tool) => tool.name === AUTOMATIONS_TOOL_NAME);
        try {
          toolResult = await automations?.execute("scheduled-list", { action: "list" });
        } catch (error) {
          toolError = String(error);
        }
        return { payloads: [{ text: "Listed automations" }], meta: { agentMeta: {} } };
      });
    });
    const execution = new CronService({
      scheduler: createTestGatewayScheduler(),
      storePath: path.join(stateDir, "cron", "jobs.json"),
      cronEnabled: true,
      defaultAgentId: "main",
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runSchedulerOwned: createScheduledGatewayRunner(() => context),
      onEvent: (event) => {
        if (event.action === "finished") {
          finished.resolve(event);
        }
      },
      runIsolatedAgentJob: (request) =>
        runCronIsolatedAgentTurn({
          ...request,
          cfg: config,
          deps: {},
          agentId: "main",
          sessionKey: `cron:${request.job.id}`,
        }),
    });
    context.cron = execution;
    const client = createOperatorClient({
      profileName: "manual-tool-authority",
      scopes: ["operator.read", "operator.write", "operator.admin"],
    });
    // The admin request source lives through admission, then closes before the job's tool call.
    const source = expectDefined(
      await captureGatewayOperatorRunAuthority({ client, context }),
      "operator request source",
    );
    client.internal = { operatorRunAuthority: source.authority };
    const asOperator = <T>(run: () => Promise<T>) =>
      withPluginRuntimeGatewayRequestScope(
        { client, context, resolveGatewayContext: () => context, isWebchatConnect: () => false },
        run,
      );
    await execution.start();
    try {
      const added = await asOperator(() =>
        dispatchGatewayMethodInProcessRaw("cron.add", {
          name: "Manual tool authority",
          enabled: true,
          schedule: { kind: "every", everyMs: 3_600_000 },
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "List automations", toolsAllow },
          delivery: { mode: "none" },
        }),
      );
      expect(added).toMatchObject({ ok: true });
      const jobId = expectDefined((await fixture.read())[0], "stored job").id;
      const accepted = await asOperator(() =>
        dispatchGatewayMethodInProcessRaw("cron.run", { id: jobId, mode: "force" }),
      );
      expect(accepted).toMatchObject({ ok: true, payload: { enqueued: true } });
      // Preparation finished under the stored job; now the admin request ends.
      await toolsReady.promise;
      source.release();
      if (withdraw === "disable") {
        await execution.update(jobId, { enabled: false });
      } else if (withdraw === "remove") {
        await execution.remove(jobId);
      }
      continueTool.resolve();
      const finishedEvent = await finished.promise;

      if (withdraw) {
        expect(toolError).toMatch(/abort/i);
        expect(listHandler).not.toHaveBeenCalled();
      } else if (toolsAllow.includes("read")) {
        expect(offeredTools).toContain("read");
        expect(offeredTools).not.toContain(AUTOMATIONS_TOOL_NAME);
        expect(toolResult).toBeUndefined();
        expect(listHandler).not.toHaveBeenCalled();
        expect(finishedEvent.status).toBe("ok");
      } else {
        expect(toolError).toBeUndefined();
        expect(listHandler).toHaveBeenCalledOnce();
        // The run gets the job's restricted inventory, not the admin caller's.
        expect(toolResult).toMatchObject({ details: { scope: "caller", jobs: [] } });
        expect(finishedEvent.status).toBe("ok");
      }
    } finally {
      continueTool.resolve();
      source.release();
      execution.stop();
    }
  });
});
