import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { normalizeAcceptedSessionSpawnResult } from "../../accepted-session-spawn.js";
import { AGENT_RUN_TERMINAL_RETRY_GRACE_MS } from "../../agent-run-terminal-outcome.js";
import { prepareAgentRunTerminalReply } from "../../agent-run-terminal-reply.js";
import type { EmbeddedAgentRunResult } from "../../embedded-agent.js";
import {
  createAgentsWaitTool,
  readNativeSubagentCollection,
} from "../../tools/agents-wait-tool.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import { createSessionsSendTool } from "../../tools/sessions-send-tool.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import {
  materializeSessionProjection,
  recordFinal,
} from "./subagent-spawn.boundary-run.test-support.js";
import {
  createBoundSpawnInvocation,
  type NativePluginSpawnTestOptions,
} from "./subagent-spawn.production-boundary.test-support.js";

type Bound = Awaited<ReturnType<NativePluginSpawnTestOptions["createBoundParent"]>>;

/** A report whose tail is unique, so a 4,096-character preview cannot pass for it. */
function report(name: string, chars: number) {
  const tail = `\nEND OF ${name} REPORT`;
  const line = `${name}: finding with evidence and file:line pointers.\n`;
  return `${line.repeat(Math.ceil(chars / line.length)).slice(0, chars - tail.length)}${tail}`;
}

/** The embedded runner's own terminal evidence: a bounded preview of the reply. */
function producerResult(text: string): EmbeddedAgentRunResult {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 1,
      terminalReply: prepareAgentRunTerminalReply({ rawText: text }).terminalReply,
    },
  };
}

async function spawnCollector(bound: Bound, task: string, runTimeoutSeconds?: number) {
  const spawned = await createBoundSpawnInvocation(bound, {
    collect: true,
    context: "isolated",
    task,
    ...(runTimeoutSeconds !== undefined ? { runTimeoutSeconds } : {}),
  })(`spawn-${task}`);
  expect(spawned.details, JSON.stringify(spawned.details)).toMatchObject({ status: "accepted" });
  return expectDefined(normalizeAcceptedSessionSpawnResult(spawned), `accepted ${task}`);
}

function waitForResults(bound: Bound, ids: string[]) {
  return createAgentsWaitTool({
    config: bound.cfg,
    agentSessionKey: bound.parentSessionKey,
    agentId: "main",
  }).execute("collector-results", { ids, awaitResults: true });
}

export function registerCollectorResultSpawnCases(options: NativePluginSpawnTestOptions) {
  it("collects each collector child's complete answer instead of its lifecycle preview", async () => {
    const bound = await options.createBoundParent();
    const { runtime } = await options.createBoundGateway(bound);
    const answers = {
      complete: report("COMPLETE", 10_000),
      unrecorded: report("UNRECORDED", 6_000),
      oversized: report("OVERSIZED", 120 * 1024),
    };
    options.runEmbeddedAgent.mockImplementation(async (params) => {
      const name = expectDefined(
        (Object.keys(answers) as Array<keyof typeof answers>).find((key) =>
          params.prompt.includes(`${key} task`),
        ),
        "collector task",
      );
      // The unrecorded child loses its transcript answer, as retention cleanup can.
      if (name !== "unrecorded") {
        await recordFinal(bound, params, answers[name]);
      }
      return producerResult(answers[name]);
    });
    const failures: unknown[] = [];
    const runIds: string[] = [];
    try {
      for (const name of Object.keys(answers)) {
        runIds.push((await spawnCollector(bound, `${name} task`)).runId);
      }
      const [complete, unrecorded, oversized] = runIds;
      // Plugin runtime collection validates the same output before returning it.
      const collected = readNativeSubagentCollection((await waitForResults(bound, runIds)).details);
      const result = (runId: string | undefined) =>
        expectDefined(
          collected.completed.find((item) => item.runId === runId),
          `collected ${runId}`,
        );
      // The producer's bounded evidence remains the fallback after payloads leave resident memory.
      const preview = prepareAgentRunTerminalReply({ rawText: answers.unrecorded }).terminalReply;
      if (preview?.disposition !== "visible") {
        throw new Error("Missing unrecorded child's lifecycle preview");
      }
      expect(result(complete)).toMatchObject({ status: "done", result: answers.complete });
      expect(result(complete)).not.toHaveProperty("resultTruncated");
      expect(result(unrecorded)).toMatchObject({
        status: "done",
        resultTruncated: true,
        result: `${preview.text}\n\n[truncated: the complete child answer is unavailable; this is its 4,096-character preview]`,
      });
      const bounded = result(oversized);
      expect(bounded.resultTruncated).toBe(true);
      // The frozen-output cap is covered at the registry owner; retain reader propagation here.
      expect(bounded.result).toContain("[truncated: frozen completion output exceeded 100KB");
    } catch (error) {
      failures.push(error);
    } finally {
      failures.push(...(await options.closeBoundGateway(bound, runtime, runIds[0])));
      options.throwBoundFailures(failures);
    }
  });

  it("refuses to continue a timed-out collector child with an actionable error and no model call", async () => {
    const bound = await options.createBoundParent();
    const { context, runtime } = await options.createBoundGateway(bound);
    // sessions_send resolves its target through the Gateway's session projection.
    await materializeSessionProjection(bound, context);
    // A controlled clock that still runs at real pace, so Gateway work is not starved.
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout"],
      shouldAdvanceTime: true,
    });
    const fakeSetTimeout = globalThis.setTimeout;
    const graceArmed = createDeferred();
    const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      // The registry holds a timed-out run for one retry grace before settling it.
      if (delay === AGENT_RUN_TERMINAL_RETRY_GRACE_MS) {
        graceArmed.resolve();
      }
      return fakeSetTimeout(handler, delay, ...args);
    }) as typeof setTimeout);
    options.runEmbeddedAgent.mockImplementation(async () => {
      // The child outlives its 60-second run budget, like the reported 180 s and 480 s children.
      vi.setSystemTime(Date.now() + 61_000);
      return { payloads: [], meta: { durationMs: 61_000, aborted: false } };
    });
    const failures: unknown[] = [];
    let childRunId: string | undefined;
    try {
      const child = await spawnCollector(bound, "timeout task", 60);
      childRunId = child.runId;
      const settled = waitForResults(bound, [child.runId]);
      await graceArmed.promise;
      await vi.advanceTimersByTimeAsync(AGENT_RUN_TERMINAL_RETRY_GRACE_MS);
      const collected = await settled;
      expect(collected.details).toMatchObject({
        completed: [{ runId: child.runId, status: "timeout" }],
      });
      const modelCalls = options.runEmbeddedAgent.mock.calls.length;
      const caller = createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: bound.admitted,
        agentId: "main",
        sessionKey: bound.parentSessionKey,
      });
      const continued = await withPluginRuntimeGatewayRequestScope(
        { context: context as GatewayRequestContext, isWebchatConnect: () => false },
        () =>
          withGatewayToolCallerIdentity(caller, () =>
            createSessionsSendTool({
              config: bound.cfg,
              agentSessionKey: bound.parentSessionKey,
              agentSessionId: "parent-session",
              requesterTurnRunId: bound.parentRunId,
            }).execute!("continue-timed-out-collector", {
              sessionKey: child.childSessionKey,
              message: "Continue the same plan from where you stopped.",
              mode: "followup",
              timeoutSeconds: 30,
            }),
          ),
      );
      expect(continued.details).toMatchObject({
        status: "error",
        error: expect.stringMatching(
          /^Collector children \(spawned with collect=true\) are one-shot: .*agents_wait.*sessions_spawn.*larger runTimeoutSeconds.*omit collect/u,
        ),
      });
      expect(JSON.stringify(continued.details)).not.toContain("swarmCollector=true");
      expect(modelCalls).toBe(1);
      expect(options.runEmbeddedAgent).toHaveBeenCalledTimes(modelCalls);
      expect(subagentRuns.get(child.runId)?.collectorCompletion?.status).toBe("timeout");
    } catch (error) {
      failures.push(error);
    } finally {
      failures.push(...(await options.closeBoundGateway(bound, runtime, childRunId)));
      timers.mockRestore();
      vi.useRealTimers();
      options.throwBoundFailures(failures);
    }
  });
}
