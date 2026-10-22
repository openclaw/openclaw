import { setImmediate } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTurnSequenceStream,
  makeCall,
  model,
  user,
} from "../../../packages/agent-core/src/agent-loop.test-support.js";
import { Agent } from "../../../packages/agent-core/src/agent.js";
import {
  getAgentToolExecutionContext,
  type AgentToolPendingInput,
} from "../../../packages/agent-core/src/tool-execution-context.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { createSubagentRunRecord } from "../subagent-test-fixtures.test-helpers.js";
import type { SubagentRunRecord } from "../subagents/registry/subagent-registry.types.js";
import { createSubagentsTool } from "./subagents-tool.js";
const owner = vi.hoisted(() => ({
  runs: [] as SubagentRunRecord[],
  listeners: new Set<() => void>(),
  cancel: vi.fn(),
  onWaitSubscribed: undefined as (() => void) | undefined,
}));
// mock-isolation: cancellation belongs to the synthetic run owner, not the live registry.
vi.mock("../subagents/registry/subagent-control.js", () => ({
  killSubagentRunAdmin: owner.cancel,
}));
vi.mock("../subagents/registry/subagent-control-scope.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../subagents/registry/subagent-control-scope.js")>();
  return {
    ...actual,
    ensureSubagentControllerOwnsRun: () => undefined,
    listControlledSubagentRunFacts: (key: string) =>
      owner.runs.filter((entry) => entry.requesterSessionKey === key),
  };
});
vi.mock("../subagents/registry/subagent-registry-state.js", () => ({
  getSubagentSessionListReadSnapshotIdentity: () => "ready",
  prepareSubagentSessionListReadCache: async () => {},
  prepareSubagentRunsSnapshotForRunIds: async () => ({
    consume: (read: (snapshot: ReadonlyMap<string, SubagentRunRecord>) => unknown) => ({
      ready: true,
      value: read(new Map(owner.runs.map((entry) => [entry.runId, entry]))),
    }),
  }),
}));
vi.mock("../subagents/registry/subagent-registry-publication.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../subagents/registry/subagent-registry-publication.js")>();
  return {
    ...actual,
    subscribeSubagentRunChanges: ((phase, listener) => {
      if (phase === "projection") {
        return actual.subscribeSubagentRunChanges(phase, listener);
      }
      const wake = () => listener({ runIds: undefined, sessionKeys: undefined });
      owner.listeners.add(wake);
      owner.onWaitSubscribed?.();
      return () => owner.listeners.delete(wake);
    }) satisfies typeof actual.subscribeSubagentRunChanges,
  };
});
let entry: SubagentRunRecord;
beforeEach(() => {
  owner.listeners.clear();
  owner.cancel.mockReset();
  owner.onWaitSubscribed = undefined;
  entry = createSubagentRunRecord({ runId: "native-one", generation: 1 });
  owner.runs = [entry];
});
const mainSession = "agent:main:main";
const tool = createSubagentsTool({ config: {}, agentId: "main", agentSessionKey: mainSession });
function wait(timeoutSeconds?: number, signal?: AbortSignal) {
  return tool.execute("wait", { action: "wait", runIds: [entry.runId], timeoutSeconds }, signal);
}
const publish = () => owner.listeners.forEach((emit) => emit());
describe("subagents native run contract", () => {
  it.for(["external_user", "inter_session"] as const)(
    "wakes the real runtime wait for admitted %s input without cancelling the child",
    async (kind, { signal }) => {
      entry.delivery = { status: "pending" };
      const originalExecution = entry.execution;
      const waitSubscribed = createDeferred();
      owner.onWaitSubscribed = () => waitSubscribed.resolve();
      let waitResult: Awaited<ReturnType<typeof tool.execute>> | undefined;
      let capturedInput: AgentToolPendingInput | undefined;
      let retainedNotifications = 0;
      const requests: NonNullable<Parameters<typeof createTurnSequenceStream>[1]> = [];
      const agent = new Agent({
        initialState: {
          model,
          tools: [
            {
              ...tool,
              execute: async (...args) => {
                capturedInput = getAgentToolExecutionContext()?.pendingInput;
                // Deliberately retain this subscription: invocation disposal must remove it.
                capturedInput?.subscribe(() => {
                  retainedNotifications += 1;
                });
                waitResult = await tool.execute(...args);
                return waitResult;
              },
            },
          ],
        },
        streamFn: createTurnSequenceStream(
          [
            [
              {
                ...makeCall("subagents"),
                arguments: {
                  action: "wait",
                  runIds: [entry.runId],
                  timeoutSeconds: 60,
                },
              },
            ],
            [{ type: "text", text: "Input observed; child remains running." }],
          ],
          requests,
        ),
      });
      const pending = agent.prompt("Wait for the selected child.");
      try {
        await withinTest(waitSubscribed.promise, signal);
        const correction = {
          ...user("SYNTHETIC_ADMITTED_CORRECTION"),
          provenance: kind === "external_user" ? { kind } : { kind, sourceTool: "sessions_send" },
        };
        agent.steer(correction);
        // All fixture work is microtask-only; one event-loop fence exposes a missing wake.
        await setImmediate();
        expect(waitResult?.details, "admitted input must release the actual wait").toMatchObject({
          reason: "input",
          completed: [],
          runs: [{ runId: entry.runId }],
        });
        await withinTest(pending, signal);
        expect(requests).toHaveLength(2);
        expect(
          requests[1]?.filter(
            (message) =>
              message.role === "user" && message.content === "SYNTHETIC_ADMITTED_CORRECTION",
          ),
        ).toHaveLength(1);
        expect(entry.execution).toBe(originalExecution);
        expect(entry.delivery).toEqual({ status: "pending" });
        expect(owner.cancel).not.toHaveBeenCalled();
        expect(owner.listeners.size).toBe(0);
        expect(capturedInput).toBeDefined();
        expect(retainedNotifications).toBe(1);
        agent.steer(user("SYNTHETIC_LATER_RUN_INPUT"));
        capturedInput?.subscribe(() => {
          retainedNotifications += 1;
        });
        agent.steer(user("SYNTHETIC_ANOTHER_LATER_INPUT"));
        expect(capturedInput?.hasPending()).toBe(false);
        expect(retainedNotifications).toBe(1);
      } finally {
        agent.abort();
        await pending;
      }
    },
  );
  it("subscribes before reading and does not consume the completed result's delivery obligation", async () => {
    entry.delivery = { status: "pending" };
    const pending = wait();
    expect(owner.listeners.size).toBe(1);
    entry.execution = { status: "terminal", endedAt: 100, outcome: { status: "ok" } };
    publish();
    expect((await pending).details).toMatchObject({
      reason: "completed",
      completed: [entry.runId],
      runs: [{ runId: entry.runId, deliveryStatus: "pending" }],
    });
    expect(owner.listeners.size).toBe(0);
    expect(entry.delivery.status).toBe("pending");
  });
  it("rechecks wait ownership without disclosing revoked results and reports suspended delivery", async () => {
    const pending = wait();
    entry.requesterSessionKey = "agent:other:main";
    entry.execution = {
      status: "terminal",
      endedAt: 100,
      outcome: { status: "error", error: "FORMER_CHILD_PRIVATE_RESULT" },
    };
    publish();
    const revoked = await pending;
    expect(revoked.details).toMatchObject({
      reason: "unavailable",
      unavailable: [entry.runId],
      runs: [],
    });
    expect(JSON.stringify(revoked.details)).not.toContain("FORMER_CHILD_PRIVATE_RESULT");
    entry.requesterSessionKey = mainSession;
    entry.delivery = { status: "suspended" };
    expect((await wait(0)).details).toMatchObject({
      reason: "attention",
      attention: [entry.runId],
    });
    expect(owner.cancel).not.toHaveBeenCalled();
  });
  it("zero-timeout and abort do not cancel execution", async () => {
    expect((await wait(0)).details).toMatchObject({ reason: "timeout" });
    expect(tool.parameters).toHaveProperty(
      "properties.timeoutSeconds.description",
      expect.stringMatching(/integer.*0–60.*default: 30.*0.*snapshot/),
    );
    const controller = new AbortController();
    const pending = wait(undefined, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(owner.cancel).not.toHaveBeenCalled();
    expect(owner.listeners.size).toBe(0);
  });
  it("never lets a revoked controller selection cancel after an await", async () => {
    owner.cancel.mockImplementation(
      async (_params: unknown, control: { assertCurrent: () => void }) => {
        control.assertCurrent();
        owner.runs = [];
        await Promise.resolve();
        control.assertCurrent();
      },
    );
    await expect(tool.execute("cancel", { action: "cancel", runId: entry.runId })).rejects.toThrow(
      "cancellation owner changed",
    );
  });
});
