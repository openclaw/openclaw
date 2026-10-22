import { describe, expect, it } from "vitest";
import { consumeCronCreatorAuthorityGrant } from "../../gateway/cron-creator-authority-grant.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  bindActiveCronCreatorAuthorityResolver,
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityResolver,
} from "../cron-creator-authority-context.js";
import {
  buildReminderAgentTurnJob,
  callGatewayMock,
  createTestCronTool,
  executeCron,
  installCronToolTestFixture,
  readGatewayCall,
} from "./cron-tool.test-support.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";

describe("cron tool authority lifecycle", () => {
  installCronToolTestFixture();

  function runWithTestCronCreatorAuthority<T>(
    runId: string,
    run: () => T,
    signal?: AbortSignal,
  ): T {
    const capability = createCronCreatorAuthorityCapability(runId);
    if (!capability) {
      throw new Error("expected cron creator authority capability");
    }
    return runWithCronCreatorAuthorityCapability(capability, run, signal);
  }

  it("does not write when the admitted run aborts while lazy authority resolves", async () => {
    let finishResolution!: () => void;
    const resolution = new Promise<void>((resolve) => {
      finishResolution = resolve;
    });
    const abortController = new AbortController();
    const run = runWithTestCronCreatorAuthority(
      "run-timeout",
      () => {
        const resolveCreatorToolAuthority = runWithCronCreatorAuthorityResolver({
          runId: "run-timeout",
          resolve: async () => {
            await resolution;
            return {
              tools: ["read", "configured__lookup"],
              provenance: { version: 1, source: "final-executable-surface" },
            };
          },
          run: () => bindActiveCronCreatorAuthorityResolver("run-timeout"),
        });

        return executeCron(
          {
            action: "add",
            job: buildReminderAgentTurnJob(),
          },
          {
            agentSessionKey: "agent:main:main",
            resolveCreatorToolAuthority,
          },
        );
      },
      abortController.signal,
    );

    abortController.abort(new Error("run timed out"));
    finishResolution();
    await expect(run).rejects.toThrow();
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("lets a later cron operation rematerialize after an earlier operation abort", async () => {
    const firstResolution = createDeferredCore();
    const discoveryStarted = createDeferredCore();
    let materializations = 0;
    let discoverySignal: AbortSignal | undefined;
    callGatewayMock.mockImplementation(async () => {
      const grant = getGatewayToolCallerIdentity()?.cronCreatorAuthorityGrant;
      expect(grant).toBeDefined();
      consumeCronCreatorAuthorityGrant(grant!);
      return { ok: true };
    });

    await runWithTestCronCreatorAuthority("run-operation-retry", async () => {
      const resolveCreatorToolAuthority = runWithCronCreatorAuthorityResolver({
        runId: "run-operation-retry",
        resolve: async (options) => {
          discoverySignal = options?.signal;
          discoveryStarted.resolve();
          materializations += 1;
          if (materializations === 1) {
            await firstResolution.promise;
          }
          return {
            tools: ["read", "configured__lookup"],
            provenance: { version: 1, source: "final-executable-surface" },
          };
        },
        run: () => bindActiveCronCreatorAuthorityResolver("run-operation-retry"),
      });
      const tool = createTestCronTool({
        agentSessionKey: "agent:main:main",
        resolveCreatorToolAuthority,
      });
      const firstOperation = new AbortController();
      const firstWrite = tool.execute(
        "call-operation-retry-first",
        { action: "add", job: buildReminderAgentTurnJob() },
        firstOperation.signal,
      );
      await discoveryStarted.promise;
      firstOperation.abort(new Error("first cron call timed out"));
      firstResolution.resolve();
      await expect(firstWrite).rejects.toThrow("first cron call timed out");
      expect(discoverySignal?.aborted).toBe(true);
      expect(callGatewayMock).not.toHaveBeenCalled();

      await tool.execute(
        "call-operation-retry-second",
        { action: "add", job: buildReminderAgentTurnJob() },
        new AbortController().signal,
      );
    });

    expect(materializations).toBe(2);
    expect(callGatewayMock).toHaveBeenCalledOnce();
    expect(readGatewayCall().params).toMatchObject({
      payload: { toolsAllow: ["*"] },
    });
    expect(readGatewayCall().params?.payload).not.toHaveProperty("toolsAllowIsDefault");
  });

  it("does not commit when the exact cron tool call aborts after grant mint", async () => {
    const operation = new AbortController();
    let committedWrites = 0;
    callGatewayMock.mockImplementation(async () => {
      const grant = getGatewayToolCallerIdentity()?.cronCreatorAuthorityGrant;
      expect(grant).toBeDefined();
      operation.abort(new Error("cron tool call timed out before commit"));
      consumeCronCreatorAuthorityGrant(grant!);
      committedWrites += 1;
      return { ok: true };
    });
    const run = runWithTestCronCreatorAuthority("run-abort-before-commit", () => {
      const resolveCreatorToolAuthority = runWithCronCreatorAuthorityResolver({
        runId: "run-abort-before-commit",
        resolve: async () => ({
          tools: ["read", "configured__lookup"],
          provenance: { version: 1, source: "final-executable-surface" },
        }),
        run: () => bindActiveCronCreatorAuthorityResolver("run-abort-before-commit"),
      });
      const tool = createTestCronTool({
        agentSessionKey: "agent:main:main",
        resolveCreatorToolAuthority,
      });
      return tool.execute(
        "call-abort-before-commit",
        { action: "add", job: buildReminderAgentTurnJob() },
        operation.signal,
      );
    });

    await expect(run).rejects.toThrow("Configured MCP cron authority is no longer active");
    expect(committedWrites).toBe(0);
  });
});
