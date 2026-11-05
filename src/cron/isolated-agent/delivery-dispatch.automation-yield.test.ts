import { expect, it, vi } from "vitest";
import { createRequesterYieldCallback } from "../../agents/openclaw-tools.requester-yield.js";
import {
  createSubagentStoreRunFixture,
  saveSubagentRegistryToSqlite,
} from "../../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "../../agents/subagents/registry/subagent-registry-state.js";
import { isToolResultError } from "../../agents/tool-result-error.js";
import { createSessionsYieldTool } from "../../agents/tools/sessions-yield-tool.js";
import {
  installQueueTestPlugin,
  useOutboundRuntime,
} from "../../infra/outbound/deliver.custody.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import { dispatchCronDelivery } from "./delivery-dispatch.js";
import { makeBaseParams } from "./delivery-dispatch.test-fixtures.js";

// The ended automation has no parent synthesis; only the child owns final output.
vi.mock("../../agents/run-wait.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/run-wait.js")>()),
  readLatestAssistantReply: async () => undefined,
}));

useOutboundRuntime();

it.each(["none", "announce"] as const)(
  "settles child output after automation yield under delivery %s",
  async (mode) => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
      async () => {
        installQueueTestPlugin();
        const send = vi.fn(async (_to: string, text: string) => ({ messageId: text }));
        const params = makeBaseParams({ spawnOnlyHandoff: true, runStartedAt: 10 });
        params.cfgWithAgentDefaults = { gateway: { controlUi: { enabled: false } } };
        params.deps = { matrix: send };
        params.job.delivery = { mode, channel: "matrix", to: "!room:example" };
        params.deliveryPlan = resolveCronDeliveryPlan(params.job);
        params.deliveryRequested = params.deliveryPlan.requested;
        params.resolvedDelivery = {
          ok: true,
          mode: "explicit",
          channel: "matrix",
          to: "!room:example",
        };
        params.synthesizedText = params.summary = params.outputText = undefined;
        const child = createSubagentStoreRunFixture({
          requesterSessionKey: params.runSessionKey,
          requesterDisplayKey: params.runSessionKey,
          createdAt: 10,
          execution: { status: "running", startedAt: 10 },
          completion: { required: false },
          delivery: { status: "not_required" },
        });
        saveSubagentRegistryToSqlite(new Map([[child.runId, child]]));
        clearSubagentRunsReadCacheForTest();
        const onYield = vi.fn();
        const tool = createSessionsYieldTool({
          sessionId: params.sessionId,
          claimYield: createRequesterYieldCallback({
            requesterSessionKey: params.runSessionKey,
            requesterAgentId: params.agentId,
          }),
          onYield,
        });
        const yielded = await tool.execute("yield", { waitFor: "message" });
        expect(yielded.details).toMatchObject({ status: "yielded" });
        expect(isToolResultError(yielded)).toBe(false);
        expect(onYield).toHaveBeenCalledExactlyOnceWith("Turn yielded.", undefined, undefined);

        const reply = "Dependency update complete.";
        child.execution = { status: "terminal", endedAt: 20, outcome: { status: "ok" } };
        child.completion = {
          required: false,
          resultText: reply,
          terminalReply: { disposition: "visible", text: reply },
        };
        saveSubagentRegistryToSqlite(new Map([[child.runId, child]]));
        clearSubagentRunsReadCacheForTest();
        const result = await dispatchCronDelivery(params);
        expect(result.disposition).toBeUndefined();
        expect(result.outputText).toBe(reply);
        expect(result.deliveryState.status).toBe(
          mode === "announce" ? "delivered" : "not-requested",
        );
        expect(send.mock.calls.map(([, text]) => text)).toEqual(mode === "announce" ? [reply] : []);
      },
    );
  },
);
