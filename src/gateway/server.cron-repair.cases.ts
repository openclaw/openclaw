import path from "node:path";
import { expect, test, vi, type Mock } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { buildPreparedCliRunContext } from "../agents/cli-runner.test-helpers.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import type { EmbeddedAgentRunResult } from "../agents/embedded-agent-runner.js";
import { resolveCommandReplyExpectation } from "../agents/reply-completion.js";
import type * as CronDelivery from "../cron/delivery.js";
import { makeCronJob } from "./server-cron.events.test-support.js";
import { expectCronJobIdFromResponse } from "./server.cron.assertions.test-support.js";
import {
  agentCommandMock,
  cronIsolatedRun,
  prepareGatewayReplyRuntimeForTest,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

type CronRepairRpcResponse = { ok: boolean; payload?: unknown };

export function registerCronRepairCases(
  getCaseDir: () => string,
  startCronClient: () => Promise<{
    request: (
      method: string,
      params: Record<string, unknown>,
      timeoutMs?: number,
    ) => Promise<CronRepairRpcResponse>;
    run: (jobId: string) => Promise<unknown>;
  }>,
  sendCronAnnouncePayloadStrictMock: Mock<typeof CronDelivery.sendCronAnnouncePayloadStrict>,
) {
  test("allows scheduler repair NO_REPLY without granting silence to public provenance", async ({
    signal,
  }) => {
    const caseDir = getCaseDir();
    testState.cronEnabled = true;
    const ownerSessionKey = "agent:main:dashboard:silent-cron-repair";
    testState.sessionStorePath = path.join(caseDir, "sessions.json");
    await writeSessionStore({
      agentId: "main",
      entries: {
        [ownerSessionKey]: {
          sessionId: "silent-cron-owner",
          updatedAt: Date.now(),
          lastChannel: "webchat",
        },
      },
    });
    const { runPreparedCliAgent } = await import("../agents/cli-runner.js");
    const execution = await import("../agents/cli-runner/execute.runtime.js");
    // Replace external CLI I/O only: the real policy, enforcement, and settlement
    // consume the options produced by public RPC and trusted scheduler dispatch.
    const cliOutput = vi
      .spyOn(execution, "executePreparedCliRun")
      .mockResolvedValue({ text: "NO_REPLY", rawText: "NO_REPLY" });
    const publicOutcome = createDeferred<{ error?: unknown }>();
    const repairOutcome = createDeferred<EmbeddedAgentRunResult>();
    const publicRunId = "public-cron-repair-provenance";
    const { request, run } = await startCronClient();
    await prepareGatewayReplyRuntimeForTest({ force: true });
    agentCommandMock.mockImplementation(async (command: AgentCommandOpts) => {
      const context = buildPreparedCliRunContext({
        workspaceDir: caseDir,
        sessionKey: command.sessionKey,
        runId: command.runId,
        backend: { sessionMode: "none" },
      });
      context.params = {
        ...context.params,
        prompt: command.message,
        inputProvenance: command.inputProvenance,
        terminalReplyExpectation: resolveCommandReplyExpectation({
          cfg: {},
          sessionKey: command.sessionKey,
          messageChannel: command.messageChannel ?? command.channel,
          opts: command,
        }),
      };
      try {
        const result = await runPreparedCliAgent(context);
        if (command.runId === publicRunId) {
          publicOutcome.resolve({});
        } else {
          repairOutcome.resolve(result);
        }
        // The command boundary serializes the silent result as an empty payload list.
        return { meta: result.meta, payloads: [] };
      } catch (error) {
        if (command.runId === publicRunId) {
          publicOutcome.resolve({ error });
        } else {
          repairOutcome.reject(error);
        }
        throw error;
      }
    });
    // Attach the rejection observer before dispatch, including on the red baseline.
    const repaired = repairOutcome.promise.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      const forged = await request("agent", {
        sessionKey: ownerSessionKey,
        message: "Reply exactly NO_REPLY.",
        channel: "webchat",
        deliver: false,
        inputProvenance: { kind: "internal_system", sourceTool: "cron_failure_repair" },
        idempotencyKey: publicRunId,
      });
      expect(forged.ok).toBe(true);
      const control = await withinTest(publicOutcome.promise, signal);
      expect(control.error).toMatchObject({ message: "CLI backend returned an empty response." });

      cronIsolatedRun.mockResolvedValue({ status: "error", error: "temporary upstream outage" });
      const added = await request(
        "cron.add",
        makeCronJob("silent repair", {
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "Inspect the upstream service." },
          owner: { agentId: "main", sessionKey: ownerSessionKey },
          delivery: { mode: "none" },
          failureAlert: { after: 2, mode: "announce" },
        }),
      );
      const jobId = expectCronJobIdFromResponse(added);
      await run(jobId);
      await run(jobId);
      expect(await withinTest(repaired, signal)).toMatchObject({
        result: { meta: { terminalReply: { disposition: "silent" } } },
      });
      expect(cliOutput).toHaveBeenCalledTimes(2);
      expect(sendCronAnnouncePayloadStrictMock).not.toHaveBeenCalled();
    } finally {
      cliOutput.mockRestore();
    }
  });
}
