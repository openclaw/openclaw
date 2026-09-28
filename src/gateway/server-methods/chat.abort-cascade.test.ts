/** Real handler and registry proof for session-wide descendant cancellation ownership. */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { registerSubagentRun } from "../../agents/subagents/registry/subagent-registry.js";
import { settleSubagentRegistryPersistenceWork } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../../agents/subagents/swarm/swarm-scheduler.js";
import { testing as swarmSchedulerTesting } from "../../agents/subagents/swarm/swarm-scheduler.test-support.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as gatewayWorkAdmission from "../../process/gateway-work-admission.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { createWorkerInferenceCancellationService } from "../worker-environments/inference-control.test-helpers.js";
import { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.js";
import * as transcriptInject from "./chat-transcript-inject.js";
import * as transcriptPersistence from "./chat-transcript-persistence.js";
import { requireLastRespondCall } from "./chat.abort-authorization.test-helpers.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";

vi.mock("../session-utils.js", async () => ({
  ...(await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js")),
  loadSessionEntry: (sessionKey: string) => ({
    cfg: {},
    agentId: "main",
    canonicalKey: sessionKey,
    entry: { sessionId: "main-session" },
  }),
}));

vi.mock("../../agents/subagents/registry/subagent-registry-state.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../agents/subagents/registry/subagent-registry-state.js")
  >()),
  persistSubagentRunsToDisk: () => {},
  persistSubagentRunsToDiskOrThrow: () => {},
}));

describe("descendant cascade ownership", () => {
  let rootWork: MockInstance<
    typeof gatewayWorkAdmission.runWithGatewayIndependentRootWorkAdmission
  >;

  beforeEach(() => {
    rootWork = vi.spyOn(gatewayWorkAdmission, "runWithGatewayIndependentRootWorkAdmission");
  });
  afterEach(async () => {
    await vi.dynamicImportSettled();
    // Join real detached finalization before checking for leaked registry roots.
    let settled = 0;
    while (settled < rootWork.mock.results.length) {
      const pending = rootWork.mock.results.slice(settled);
      settled += pending.length;
      await Promise.allSettled(
        pending.flatMap((result) => (result.type === "return" ? [result.value] : [])),
      );
    }
    await settleSubagentRegistryPersistenceWork();
    resetSubagentRegistryForTests({ persist: false });
    swarmSchedulerTesting.reset();
    vi.restoreAllMocks();
  });

  it("does not stop descendants after the original caller is revoked during parent cancellation", async () => {
    const sessionKey = "agent:main:main";
    const childKey = "agent:main:subagent:retained-stop";
    await registerSubagentRun({
      runId: "retained-stop-child",
      childSessionKey: childKey,
      requesterSessionKey: sessionKey,
      requesterAgentId: "main",
      requesterTurnRunId: "parent",
      requesterDisplayKey: sessionKey,
      task: "retain original Stop authority",
      cleanup: "keep",
      collect: true,
    });
    const started = createDeferred();
    const start = vi.fn(async () => {
      started.resolve();
    });
    enqueueSwarmRun({
      groupId: "retained-stop",
      runId: "retained-stop-child",
      maxConcurrent: 1,
      activeRunIds: ["held-capacity"],
      start,
      onStartFailure: () => true,
    });
    let current = true;
    const parent = createActiveRun(sessionKey, { agentId: "main", owner: { connId: "owner" } });
    parent.controller.signal.addEventListener("abort", () => {
      current = false;
    });
    const context = createChatAbortContext({ chatAbortControllers: new Map([["parent", parent]]) });
    context.chatRunState.getOrCreate("parent").buffer = "cancelled parent partial";
    const persist = vi
      .spyOn(transcriptPersistence, "persistAbortedPartials")
      .mockResolvedValue(undefined);
    const respond = await invokeChatAbortHandler({
      handler: (options) =>
        handleChatAbortRequestWithLifecycle({
          ...options,
          hasCurrentClientAuthority: () => current,
        }),
      context,
      request: { sessionKey, runId: "parent" },
      client: { connId: "owner", connect: { scopes: ["operator.write"] } },
    });
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringMatching(
          /Parent run stopped, but descendant cancellation was incomplete: .*Gateway requester authority changed/,
        ),
      }),
    );
    expect(parent.controller.signal.aborted).toBe(true);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist.mock.calls[0]?.[0].snapshots.map((snapshot) => snapshot.runId)).toEqual([
      "parent",
    ]);
    expect(getSubagentRunByChildSessionKey(childKey)?.execution.endedAt).toBeUndefined();
    expect(start).not.toHaveBeenCalled();
    releaseSwarmRun("held-capacity");
    await started.promise;
    expect(start).toHaveBeenCalledOnce();
  });

  it.each([
    "owned",
    "orphan",
    "all foreign",
    "all foreign hidden",
    "late descendant",
    "mixed active",
    "mixed queued",
    "mixed pending agent",
    "mixed pending chat",
    "hidden",
    "preserved",
    "hidden pending",
    "unrepresented worker",
    "represented worker",
    "hidden worker",
    "ordinary",
  ])("does not kill or inhibit excluded queued descendants: %s", async (kind) => {
    const sessionKey = kind.includes("worker") ? "global" : "agent:main:main";
    const cfg: OpenClawConfig = sessionKey === "global" ? { session: { scope: "global" } } : {};
    const childKey = "agent:main:subagent:cascade-ownership";
    const canCascade = ["owned", "orphan", "represented worker", "late descendant"].includes(kind);
    const hasOwnedActive = kind !== "orphan" && !kind.startsWith("all foreign");
    const mine = createActiveRun(sessionKey, {
      sessionId: "main-session",
      agentId: "main",
      owner: { connId: "conn-owner", deviceId: "dev-owner" },
    });
    const foreign = createActiveRun(sessionKey, {
      sessionId: "main-session",
      agentId: "main",
      owner: { connId: "conn-foreign", deviceId: "dev-foreign" },
      controlUiVisible: ["hidden", "hidden worker", "all foreign hidden"].includes(kind)
        ? false
        : undefined,
      turnKind: kind === "preserved" ? "btw" : undefined,
    });
    const context = createChatAbortContext({ getRuntimeConfig: () => cfg });
    if (hasOwnedActive) {
      context.chatAbortControllers.set("run-mine", mine);
      context.chatRunState.getOrCreate("run-mine").buffer = "partial parent reply";
      mine.controller.signal.addEventListener("abort", () => {
        if (kind !== "late descendant") {
          releaseSwarmRun("capacity");
        }
      });
    }
    if (
      [
        "all foreign",
        "all foreign hidden",
        "mixed active",
        "hidden",
        "preserved",
        "hidden worker",
      ].includes(kind)
    ) {
      context.chatAbortControllers.set("run-foreign", foreign);
    }
    if (kind === "mixed queued") {
      context.chatQueuedTurns.set("run-foreign", {
        controller: foreign.controller,
        sessionKey,
        sessionId: "main-session",
        agentId: "main",
        ownerConnId: "conn-foreign",
        ownerDeviceId: "dev-foreign",
      });
    }
    if (kind.includes("pending")) {
      const prefix = kind === "mixed pending chat" ? "pending-chat:" : "agent:";
      context.dedupe.set(`${prefix}run-foreign`, {
        ts: Date.now(),
        ok: true,
        payload: {
          runId: "run-foreign",
          sessionKey,
          agentId: "main",
          status: "accepted",
          ownerConnId: "conn-foreign",
          ownerDeviceId: "dev-foreign",
          controlUiVisible: kind === "hidden pending" ? false : undefined,
        },
      });
    }
    const cancelInferenceForSession = vi.fn(() => ["worker-run"]);
    if (kind.includes("worker")) {
      const workerRunId =
        kind === "represented worker"
          ? "run-mine"
          : kind === "hidden worker"
            ? "run-foreign"
            : "worker-run";
      context.workerEnvironmentService = createWorkerInferenceCancellationService(
        "main-session",
        [workerRunId],
        cancelInferenceForSession,
      );
    }
    const registerChild = () =>
      registerSubagentRun({
        runId: "cascade-queued",
        childSessionKey: childKey,
        requesterSessionKey:
          kind === "late descendant" ? "agent:main:subagent:orchestrator" : sessionKey,
        requesterAgentId: "main",
        requesterDisplayKey: sessionKey,
        task: "preserve exclusive ownership",
        cleanup: "keep",
        collect: true,
        queued: true,
      });
    if (kind === "late descendant") {
      addSubagentRunForTests({
        runId: "orchestrator",
        childSessionKey: "agent:main:subagent:orchestrator",
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        requesterTurnRunId: "run-mine",
        requesterDisplayKey: sessionKey,
        task: "live orchestrator",
        cleanup: "keep",
        createdAt: 1,
        startedAt: 2,
      });
    } else {
      await registerChild();
    }
    const start = vi.fn(async () => {});
    enqueueSwarmRun({
      groupId: "cascade-ownership",
      runId: "cascade-queued",
      maxConcurrent: 1,
      activeRunIds: ["capacity"],
      start,
      onStartFailure: () => true,
    });
    const entered = createDeferred();
    const proceed = createDeferred();
    const admission =
      kind === "late descendant"
        ? await beginSessionWorkAdmission({
            scope: resolveSessionStorePathCore(undefined, { agentId: "main" }),
            identities: ["agent:main:subagent:orchestrator"],
            assertAllowed: () => {},
            onInterrupt: () => entered.resolve(),
          })
        : undefined;
    const append = vi
      .spyOn(transcriptInject, "appendInjectedAssistantMessageToTranscript")
      .mockImplementationOnce(async () => {
        if (kind === "late descendant") {
          releaseSwarmRun("capacity");
        }
        entered.resolve();
        await proceed.promise;
        return { ok: true, messageId: "aborted-partial" };
      });
    if (!hasOwnedActive) {
      releaseSwarmRun("capacity");
    }
    const pending = invokeChatAbortHandler({
      handler: (options) =>
        handleChatAbortRequestWithLifecycle(
          options,
          kind === "ordinary" ? {} : { cascadeDescendants: true },
        ),
      context,
      request: {
        sessionKey,
        agentId: "main",
        preserveSideRuns: kind === "preserved",
        ...(kind === "late descendant" ? { runId: "run-mine" } : {}),
      },
      client: {
        connId: "conn-owner",
        connect: {
          device: { id: "dev-owner" },
          scopes:
            kind === "hidden worker" ? ["operator.admin"] : ["operator.read", "operator.write"],
        },
      },
    });
    try {
      if (hasOwnedActive) {
        await entered.promise;
        if (kind === "late descendant") {
          expect(
            getSubagentRunByChildSessionKey("agent:main:subagent:orchestrator")?.execution.endedAt,
          ).toBeUndefined();
          await registerChild();
        }
        if (canCascade) {
          expect(
            start,
            "selected queued work does not dispatch during parent partial persistence",
          ).not.toHaveBeenCalled();
        } else {
          expect(
            start,
            "foreign/protected/ordinary work must not be held during partial persistence",
          ).toHaveBeenCalledOnce();
        }
      }
      admission?.release();
      proceed.resolve();
      const respond = await pending;
      expect(requireLastRespondCall(respond)[0]).toBe(!kind.startsWith("all foreign"));
      const child = getSubagentRunByChildSessionKey(childKey);
      if (canCascade) {
        expect(child).toMatchObject({
          endedReason: "subagent-killed",
          execution: { status: "terminal" },
        });
        expect(start).not.toHaveBeenCalled();
      } else {
        expect(child?.execution.endedAt).toBeUndefined();
        expect(start).toHaveBeenCalledOnce();
      }
      expect(foreign.controller.signal.aborted).toBe(false);
      expect(cancelInferenceForSession).not.toHaveBeenCalled();
    } finally {
      admission?.release();
      proceed.resolve();
      await pending;
      append.mockRestore();
      releaseSwarmRun("capacity");
    }
  });
});
