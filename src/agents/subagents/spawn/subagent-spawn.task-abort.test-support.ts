import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import type { GatewayRequestOptions } from "../../../gateway/server-methods/types.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { getDetachedTaskLifecycleRuntime } from "../../../tasks/detached-task-runtime.js";
import { setDetachedTaskLifecycleRuntime } from "../../../tasks/detached-task-runtime.test-support.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { SubagentRegistryWriteError } from "../registry/subagent-registry-persistence.js";
import { persistSubagentRunsToDiskAsyncOrThrow } from "../registry/subagent-registry-state.js";
import { loadSubagentRunsByRunIdsFromSqlite } from "../registry/subagent-registry.store.sqlite.js";
import { makeGatewayContext } from "./subagent-spawn.in-process-gateway.test-support.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";
import { testing as subagentSpawnTesting } from "./subagent-spawn.test-support.js";

export function registerRequiredTaskAbortTests(
  externalCliClient: () => GatewayRequestOptions["client"],
) {
  // A failed required task must stop its run while a refused rollback retains recovery state.
  const taskRowFaults: Array<[label: string, createTaskRun: () => null]> = [
    ["creates no task row", () => null],
    [
      "throws while creating the task row",
      () => {
        throw new Error("task store unavailable");
      },
    ],
  ];
  it.each(
    taskRowFaults.flatMap(([label, createTaskRun]) =>
      (["committed", "not-committed"] as const).map((rollback) => ({
        label,
        createTaskRun,
        rollback,
      })),
    ),
  )(
    "aborts the accepted child run when the task runtime $label (rollback: $rollback)",
    async ({ createTaskRun, rollback }) => {
      const gatewayContext = makeGatewayContext();
      const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
      subagentSpawnTesting.setDepsForTest({
        dispatchGatewayMethodInProcess: async <T>(
          method: string,
          params: Record<string, unknown>,
        ) => {
          requests.push({ method, params });
          if (method === "agent") {
            return { runId: "gateway-accepted-run", status: "accepted" } as T;
          }
          if (method === "chat.abort") {
            return { aborted: true, runIds: [params.runId] } as T;
          }
          return {} as T;
        },
      });
      let rollbackRefused = false;
      if (rollback === "not-committed") {
        const persist = vi.mocked(persistSubagentRunsToDiskAsyncOrThrow);
        persist
          .mockImplementationOnce(
            expectDefined(persist.getMockImplementation(), "registry persistence implementation"),
          )
          .mockImplementationOnce(async (runs, runIds) => {
            expect(runIds).toContain("gateway-accepted-run");
            expect(runs.has("gateway-accepted-run")).toBe(false);
            rollbackRefused = true;
            throw new SubagentRegistryWriteError("not-committed", new Error("rollback disk full"));
          });
      }
      // The registration commits before the task runtime fails.
      setDetachedTaskLifecycleRuntime({
        ...getDetachedTaskLifecycleRuntime(),
        createQueuedTaskRun: createTaskRun,
        createRunningTaskRun: createTaskRun,
      });

      const result = await withPluginRuntimeGatewayRequestScope(
        {
          context: gatewayContext,
          client: externalCliClient(),
          isWebchatConnect: () => false,
        },
        () =>
          spawnSubagentDirect(
            { task: "orphan me", context: "isolated", lightContext: true },
            { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
          ),
      );

      expect(rollbackRefused).toBe(rollback === "not-committed");
      expect(result.status).toBe("error");
      expect(
        requests.some(
          (request) =>
            request.method === "chat.abort" && request.params.runId === "gateway-accepted-run",
        ),
      ).toBe(true);
      const durable = loadSubagentRunsByRunIdsFromSqlite(["gateway-accepted-run"]);
      if (rollback === "not-committed") {
        const retained = { runId: "gateway-accepted-run", childSessionKey: result.childSessionKey };
        expect(subagentRuns.size).toBe(1);
        expect(subagentRuns.get("gateway-accepted-run")).toMatchObject(retained);
        expect(durable).toMatchObject([retained]);
        expect(requests.filter((request) => request.method === "sessions.delete")).toEqual([]);
      } else {
        expect(subagentRuns.size).toBe(0);
        expect(durable).toEqual([]);
      }
    },
  );
}
