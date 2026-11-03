import path from "node:path";
import { expect, test, vi, type Mock } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { buildPreparedCliRunContext } from "../agents/cli-runner.test-helpers.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import type { EmbeddedAgentRunResult } from "../agents/embedded-agent-runner.js";
import { resolveCommandReplyExpectation } from "../agents/reply-completion.js";
import type * as CronDelivery from "../cron/delivery.js";
import { loadCronStore } from "../cron/store.js";
import { makeCronJob } from "./server-cron.events.test-support.js";
import { installCronRepairTurn } from "./server.cron-repair-turn.test-support.js";
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
  test("accepts silent scheduler repairs but rejects public provenance", async ({ signal }) => {
    const caseDir = getCaseDir();
    testState.cronEnabled = true;
    const ownerSessionKey = "agent:main:dashboard:silent-cron-repair";
    testState.sessionStorePath = path.join(caseDir, "sessions.json");
    await writeSessionStore({
      agentId: "main",
      entries: {
        [ownerSessionKey]: { sessionId: "owner", updatedAt: Date.now(), lastChannel: "webchat" },
      },
    });
    const { runPreparedCliAgent } = await import("../agents/cli-runner.js");
    const execution = await import("../agents/cli-runner/execute.runtime.js");
    const cliOutput = vi.spyOn(execution, "executePreparedCliRun");
    cliOutput.mockResolvedValue({ text: "NO_REPLY", rawText: "NO_REPLY" });
    const runCli = async (
      run: Partial<Parameters<typeof runPreparedCliAgent>[0]["params"]>,
    ): Promise<{ result?: EmbeddedAgentRunResult; error?: unknown }> => {
      const context = buildPreparedCliRunContext({
        workspaceDir: caseDir,
        sessionKey: run.sessionKey,
        runId: run.runId,
        backend: { sessionMode: "none" },
      });
      context.params = { ...context.params, ...run };
      return runPreparedCliAgent(context).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
    };
    const publicOutcome = createDeferred<{ error?: unknown }>();
    const publicRunId = "public-cron-repair-provenance";
    const { request, run } = await startCronClient();
    await prepareGatewayReplyRuntimeForTest({ force: true });
    agentCommandMock.mockImplementation(async (command: AgentCommandOpts) => {
      const outcome = await runCli({
        sessionKey: command.sessionKey,
        runId: command.runId ?? publicRunId,
        prompt: command.message,
        inputProvenance: command.inputProvenance,
        terminalReplyExpectation: resolveCommandReplyExpectation({
          cfg: {},
          sessionKey: command.sessionKey,
          messageChannel: command.messageChannel ?? command.channel,
          opts: command,
        }),
      });
      publicOutcome.resolve(outcome);
      if (!outcome.result) {
        throw outcome.error;
      }
      return { meta: outcome.result.meta, payloads: [] };
    });
    const repairOutcome = createDeferred<{ result?: EmbeddedAgentRunResult; error?: unknown }>();
    const repairTurn = installCronRepairTurn(async (params) => {
      const outcome = await runCli(params);
      repairOutcome.resolve(outcome);
      if (!outcome.result) {
        throw outcome.error;
      }
      return "NO_REPLY";
    });
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
      expect(await withinTest(repairOutcome.promise, signal)).toMatchObject({
        result: { meta: { terminalReply: { disposition: "silent" } } },
      });
      expect(repairTurn.context()).toMatchObject({
        SessionKey: ownerSessionKey,
        InputProvenance: { kind: "internal_system", sourceTool: "cron_failure_repair" },
      });
      await vi.waitFor(async () => {
        const stored = await loadCronStore(path.join(caseDir, "cron", "jobs.json"));
        const repair = stored.jobs.find((job) => job.id === jobId)?.state.failureAlertIncident
          ?.repair;
        expect(repair).toMatchObject({ settledAtMs: expect.any(Number) });
      });
      expect(cliOutput).toHaveBeenCalledTimes(2);
      expect(sendCronAnnouncePayloadStrictMock).not.toHaveBeenCalled();
    } finally {
      cliOutput.mockRestore();
    }
  });
}
