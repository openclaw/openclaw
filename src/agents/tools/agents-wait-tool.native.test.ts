import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { NativeSubagentRuntime } from "../../plugins/runtime/types-native-subagent.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { persistRegistryFixture } from "../subagents/registry/subagent-registry-state.fixture.test-support.js";
import {
  createAgentsWaitTool,
  readNativeSubagentCollection,
  withNativeSubagentCollectorOwner,
} from "./agents-wait-tool.js";
import { collectorRun } from "./agents-wait-tool.test-support.js";

const key = "agent:main:main";
const owner = {
  currentSessionKeys: new Set([key]),
  currentAgentId: "main",
  expectedRequester: { sessionId: "parent", lifecycleRevision: "revision-2" },
};

async function collect(
  params: Parameters<NativeSubagentRuntime["collect"]>[0] & {
    signal?: AbortSignal;
    assertCurrent?: () => void;
  },
) {
  const result = await withNativeSubagentCollectorOwner(
    "native-collector-test",
    { ...owner, assertCurrent: params.assertCurrent ?? (() => {}) },
    () =>
      createAgentsWaitTool({ agentSessionKey: key, agentId: "main" }).execute(
        "native-collector-test",
        {
          ids: params.ids,
          timeoutSeconds: params.timeoutSeconds,
          awaitResults: params.awaitResults,
        },
        params.signal,
      ),
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
    await withOpenClawTestState(
      {
        label: "native-collector-owner",
        env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" },
      },
      async () => {
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
      },
    );
  });

  it.each(["abort", "revoke"] as const)(
    "refuses %s during asynchronous result preparation",
    async (failure) => {
      await withOpenClawTestState(
        {
          label: "native-collector-revocation",
          env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" },
        },
        async () => {
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
          await expect(result).rejects.toThrow(
            failure === "revoke" ? "request retired" : "aborted",
          );
        },
      );
    },
  );
});
