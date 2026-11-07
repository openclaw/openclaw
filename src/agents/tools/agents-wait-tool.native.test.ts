import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { NativeSubagentRuntime } from "../../plugins/runtime/types-native-subagent.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  hasUncollectedSessionSpawn,
  mergeAcceptedSessionSpawnsForRun,
  retireAcceptedSessionSpawnCompletionForRun,
} from "../accepted-session-spawn.js";
import { createOperationalRunInstanceRef } from "../operational-run-instance.js";
import { persistRegistryFixture } from "../subagents/registry/subagent-registry-state.fixture.test-support.js";
import {
  createAgentsWaitTool,
  readNativeSubagentCollection,
  withNativeSubagentCollectorOwner,
} from "./agents-wait-tool.js";
import { collectorRun } from "./agents-wait-tool.test-support.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";

const key = "agent:main:main";
const owner = {
  currentSessionKeys: new Set([key]),
  currentAgentId: "main",
  expectedRequester: { sessionId: "parent", lifecycleRevision: "revision-2" },
};
const withRegistry = (run: () => Promise<void>) =>
  withOpenClawTestState({ env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } }, run);

async function collect({
  signal,
  assertCurrent = () => {},
  ...params
}: Parameters<NativeSubagentRuntime["collect"]>[0] & {
  signal?: AbortSignal;
  assertCurrent?: () => void;
}) {
  const tool = createAgentsWaitTool({ agentSessionKey: key, agentId: "main" });
  const result = await withNativeSubagentCollectorOwner(
    tool,
    "native-collector-test",
    { ...owner, assertCurrent },
    () => tool.execute("native-collector-test", params, signal),
  );
  return readNativeSubagentCollection(result.details);
}

function record(id: string) {
  return {
    ...collectorRun(id, key),
    delivery: { status: "not_required" as const },
    completionRequesterSessionId: "parent",
    completionRequesterLifecycleRevision: "revision-2",
  };
}

describe("native collector requester ownership", () => {
  it("reads persisted pending and completed results, refusing other parents and reset incarnations", async () => {
    await withRegistry(async () => {
      const done = {
        ...record("done"),
        collectorCompletion: { status: "done" as const },
        completion: { required: false, resultText: "reviewed" },
      };
      const reset = { ...record("reset"), completionRequesterLifecycleRevision: "revision-1" };
      const foreign = { ...record("foreign"), swarmRequesterSessionKey: "agent:main:other" };
      persistRegistryFixture(
        new Map([done, record("pending"), reset, foreign].map((entry) => [entry.runId, entry])),
      );
      const result = await collect({
        ids: ["done", "pending", "reset", "foreign", "missing"],
        timeoutSeconds: 0,
      });
      expect(result.completed).toMatchObject([
        { runId: "done", result: "reviewed", status: "done" },
      ]);
      expect(result.pending).toEqual(["pending"]);
      expect(result.errors).toEqual([
        { runId: "reset", error: "not_owner" },
        { runId: "foreign", error: "not_owner" },
        { runId: "missing", error: "not_found" },
      ]);
    });
  });

  it.each(["abort", "revoke"] as const)(
    "refuses %s during asynchronous result preparation",
    async (failure) => {
      await withRegistry(async () => {
        persistRegistryFixture(new Map([["pending", record("pending")]]));
        const controller = new AbortController();
        const entered = createDeferred();
        let active = true;
        const result = collect({
          ids: ["pending"],
          awaitResults: true,
          signal: controller.signal,
          assertCurrent() {
            entered.resolve();
            if (!active) {
              throw new Error("request retired");
            }
          },
        });
        await entered.promise;
        if (failure === "revoke") {
          active = false;
        } else {
          controller.abort();
        }
        await expect(result).rejects.toThrow(failure === "revoke" ? "request retired" : "aborted");
      });
    },
  );
});

describe("agents_wait collection receipts", () => {
  it("records done collection on the admitted run's receipts for every harness", async () => {
    await withOpenClawTestState(
      {
        label: "native-collector-receipts",
        env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" },
      },
      async () => {
        const done = (id: string) => ({
          ...record(id),
          collectorCompletion: { status: "done" as const },
          completion: { required: false, resultText: "reviewed" },
        });
        persistRegistryFixture(
          new Map(
            [
              done("done"),
              { ...record("failed"), collectorCompletion: { status: "failed" as const } },
              done("cancelled"),
            ].map((entry) => [entry.runId, entry]),
          ),
        );
        const run = createOperationalRunInstanceRef("parent-run");
        const receipt = (runId: string, expectsCompletionMessage = false) => ({
          runId,
          childSessionKey: `agent:worker:subagent:${runId}`,
          expectsCompletionMessage,
        });
        // sessions_spawn records each receipt on the admitted run when it executes.
        mergeAcceptedSessionSpawnsForRun(run, [receipt("done"), receipt("cancelled", true)]);
        mergeAcceptedSessionSpawnsForRun(run, [receipt("failed")]);
        retireAcceptedSessionSpawnCompletionForRun(run, receipt("cancelled"));
        const tool = createAgentsWaitTool({ agentSessionKey: key, agentId: "main" });
        await withGatewayToolCallerIdentity(
          { agentId: "main", sessionKey: key, operationalRunInstance: run },
          () => tool.execute("wait", { ids: ["done", "failed", "cancelled"], timeoutSeconds: 0 }),
        );

        // Harnesses that only project sessions_spawn receipts (Copilot) settle through the run.
        const settled = mergeAcceptedSessionSpawnsForRun(run, [receipt("done")]);
        expect(settled).toEqual([
          { ...receipt("done"), collected: true },
          { ...receipt("cancelled"), collected: true },
          receipt("failed"),
        ]);
        expect(
          hasUncollectedSessionSpawn(settled.filter((spawn) => spawn.runId !== "failed")),
        ).toBe(false);
      },
    );
  });
});
