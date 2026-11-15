import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyEmbeddedAttemptToolsAllow } from "../../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { AUTOMATIONS_TOOL_NAME } from "../../agents/tools/automations-tool-name.js";
import { captureGatewayOperatorRunAuthority } from "../../gateway/operator-run-authority.js";
import { createScheduledGatewayRunner } from "../../gateway/scheduled-run-gateway-context.js";
import { createRequestGatewayMethodRegistry } from "../../gateway/server-methods.js";
import { cronHandlers } from "../../gateway/server-methods/cron.js";
import {
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
import type { CronEvent } from "../service.js";
import {
  createAuthorityCronService,
  prepareAuthorityConfig,
  resetAuthorityRunHarness,
  withAuthorityTools,
} from "./run.authority.test-support.js";
import * as harness from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await harness.loadRunCronIsolatedAgentTurn();
installRequesterCronAuthorityTestHooks();

beforeEach(resetAuthorityRunHarness);

afterEach(() => {
  harness.runEmbeddedAgentMock.mockReset();
});

it.each(["allowed", "senderless", "read-only", "disable", "remove"] as const)(
  "manual run retains %s tool authority after caller closure",
  async (scenario) => {
    const toolsAllow = [scenario === "read-only" ? "read" : AUTOMATIONS_TOOL_NAME];
    const withdraw = scenario === "disable" || scenario === "remove" ? scenario : undefined;
    const senderIsOwner = scenario === "senderless" ? false : undefined;
    const sessionStorePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const config = await prepareAuthorityConfig({
      session: { store: sessionStorePath },
      tools: { allow: [AUTOMATIONS_TOOL_NAME, "read"] },
    });
    harness.resolveCronSessionMock.mockReturnValue(
      harness.makeCronSession({ storePath: sessionStorePath }),
    );
    const fixture = createCronFixture(undefined, config);
    const { context } = fixture;
    context.resolveGatewayContext = () => context;
    // The real cron.list handler is the tool's final effect; the spy only counts calls.
    const listHandler = vi.fn((options: GatewayRequestHandlerOptions) =>
      expectDefined(cronHandlers["cron.list"], "cron.list")(options),
    );
    context.getGatewayMethodRegistry = () =>
      createRequestGatewayMethodRegistry({ "cron.list": listHandler });
    const toolsReady = createDeferredCore();
    const continueTool = createDeferredCore();
    const finished = createDeferredCore<CronEvent>();
    let offeredTools: string[] = [];
    let toolResult: unknown;
    let toolError: string | undefined;
    harness.runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentParams) =>
      withAuthorityTools(
        params,
        async (constructed) => {
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
        },
        {
          includeOpenClawTools: true,
          abortSignal: params.abortSignal,
          ...(senderIsOwner === false
            ? { senderIsOwner, trigger: params.trigger, jobId: params.jobId }
            : {}),
        },
      ),
    );
    const execution = createAuthorityCronService(config, runCronIsolatedAgentTurn, {
      runSchedulerOwned: createScheduledGatewayRunner(() => context),
      onEvent: (event) => {
        if (event.action === "finished") {
          finished.resolve(event);
        }
      },
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
      await Promise.race([
        toolsReady.promise,
        finished.promise.then((event) => {
          throw new Error(`Cron finished before tool construction: ${event.error ?? event.status}`);
        }),
      ]);
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
        // Admission keeps the same-job inventory after the admin caller closes.
        expect(toolResult).toMatchObject({
          details: { jobs: [{ id: jobId }] },
        });
        expect(finishedEvent.status).toBe("ok");
      }
    } finally {
      continueTool.resolve();
      source.release();
      execution.stop();
      await execution.waitForIdle();
    }
  },
);
