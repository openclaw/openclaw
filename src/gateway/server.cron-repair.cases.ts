import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, test, vi, type Mock } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { buildPreparedCliRunContext } from "../agents/cli-runner.test-helpers.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import type { EmbeddedAgentRunResult } from "../agents/embedded-agent-runner.js";
import { resolveCommandReplyExpectation } from "../agents/reply-completion.js";
import type * as CronDelivery from "../cron/delivery.js";
import { loadCronStore } from "../cron/store.js";
import type { ReplyOperation } from "../sessions/session-controller.contracts.js";
import { makeCronJob } from "./server-cron.events.test-support.js";
import { installCronRepairTurn } from "./server.cron-repair-turn.test-support.js";
import { expectCronJobIdFromResponse } from "./server.cron.assertions.test-support.js";
import {
  agentCommandMock,
  gatewayReplyMock,
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
      run: Pick<
        Parameters<typeof runPreparedCliAgent>[0]["params"],
        "sessionKey" | "runId" | "prompt" | "inputProvenance" | "terminalReplyExpectation"
      >,
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
      const repairJob = makeCronJob("silent repair", {
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "Inspect the upstream service." },
        owner: { agentId: "main", sessionKey: ownerSessionKey },
        delivery: { mode: "none" },
        failureAlert: { after: 2, mode: "announce" },
      });
      const jobId = expectCronJobIdFromResponse(await request("cron.add", repairJob));
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
  test("Stop settles scheduled work without opening a failure incident", async ({ signal }) => {
    const ownerSessionKey = "agent:main:dashboard:stopped-cron";
    testState.sessionStorePath = path.join(getCaseDir(), "sessions.json");
    await writeSessionStore({
      agentId: "main",
      entries: {
        [ownerSessionKey]: {
          sessionId: "stopped-cron-owner",
          updatedAt: Date.now(),
          lastChannel: "webchat",
        },
      },
    });
    const { request, run } = await startCronClient();
    await prepareGatewayReplyRuntimeForTest({ force: true });
    const entered = createDeferred<ReplyOperation>();
    const release = createDeferred();
    gatewayReplyMock.mockClear();
    installCronRepairTurn(async (params) => {
      const operation = expectDefined(params.replyOperation, "scheduled reply owner");
      operation.abortSignal.addEventListener("abort", () => release.resolve(), { once: true });
      entered.resolve(operation);
      await withinTest(release.promise, signal);
      return "NO_REPLY";
    });
    const jobId = expectCronJobIdFromResponse(
      await request(
        "cron.add",
        makeCronJob("stopped scheduled turn", {
          sessionTarget: `session:${ownerSessionKey}`,
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "Wait for cancellation." },
          owner: { agentId: "main", sessionKey: ownerSessionKey },
          delivery: { mode: "none" },
          failureAlert: { after: 1, cooldownMs: 0, mode: "announce" },
        }),
      ),
    );
    const finished = run(jobId);
    try {
      const operation = await withinTest(entered.promise, signal);
      expect(
        await request("sessions.abort", { key: ownerSessionKey, clearQueued: true }),
      ).toMatchObject({
        ok: true,
        payload: { ok: true, status: "aborted" },
      });
      expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
      expect(await withinTest(finished, signal)).toMatchObject({
        jobId,
        action: "finished",
        status: "error",
      });
      const stored = await loadCronStore(path.join(getCaseDir(), "cron", "jobs.json"));
      const job = expectDefined(
        stored.jobs.find((entry) => entry.id === jobId),
        "stopped job",
      );
      expect(job.state.consecutiveErrors ?? 0).toBe(0);
      expect(job.state.failureAlertIncident).toBeUndefined();
      expect(job.state.lastFailureAlertAtMs).toBeUndefined();
      expect(job.state.lastFailureNotificationDeliveryStatus).toBe("not-requested");
      expect(sendCronAnnouncePayloadStrictMock).not.toHaveBeenCalled();
      expect(gatewayReplyMock).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
    }
  });
}
