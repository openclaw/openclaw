/** Real handler and registry proof for session-wide descendant cancellation ownership. */
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  deleteSession,
  getSession,
  waitForExecSession,
  type ProcessSession,
} from "../../agents/bash-process-registry.js";
import { createLazyExecTool } from "../../agents/lazy-exec-tool.js";
import { registerSubagentRun } from "../../agents/subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { getSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../../agents/subagents/swarm/swarm-scheduler.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withExecRequestTurn } from "../../infra/exec-request-context.js";
import { getProcessSupervisor } from "../../process/supervisor/index.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { withEnvAsync } from "../../test-utils/env.js";
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

const fixture = useChatAbortRegistryFixture();
const writeSession = (sessionKey: string, sessionId: string) =>
  writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey,
    defaultSessionId: sessionId,
  });

describe("descendant cascade ownership", () => {
  it("does not stop descendants after the original caller is revoked during parent cancellation", async ({
    signal,
  }) => {
    const sessionKey = "agent:main:main";
    const childKey = "agent:main:subagent:retained-stop";
    await writeSession(sessionKey, "main-session");
    await writeSession(childKey, "retained-stop-child");
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
      queued: true,
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
    const parent = createActiveRun(sessionKey, {
      sessionId: "main-session",
      agentId: "main",
      owner: { connId: "owner" },
    });
    const turnAborted = createDeferred();
    parent.controller.signal.addEventListener("abort", () => {
      current = false;
      turnAborted.resolve();
    });
    const context = createChatAbortContext({ chatAbortControllers: new Map([["parent", parent]]) });
    context.chatRunState.getOrCreate("parent").buffer = "cancelled parent partial";
    using persist = vi
      .spyOn(transcriptPersistence, "persistAbortedPartials")
      .mockResolvedValue(undefined);
    const commandReady = createDeferred();
    const cleanupEntered = createDeferred();
    const releaseCleanup = createDeferred();
    const supervisor = getProcessSupervisor();
    const spawn = supervisor.spawn.bind(supervisor);
    let rootExitObserved = false;
    let managedCommand: Awaited<ReturnType<typeof supervisor.spawn>> | undefined;
    const spawnFailure = vi.spyOn(supervisor, "spawn").mockImplementation(async (input) => {
      const managed = await spawn(input);
      managedCommand = managed;
      return {
        ...managed,
        waitForExtinction: async () => {
          await managed.wait();
          await managed.waitForExtinction?.();
          rootExitObserved = isPidDefinitelyDead(expectDefined(managed.pid, "command pid"));
          cleanupEntered.resolve();
          await releaseCleanup.promise;
          throw new Error("Synthetic command finalization failure");
        },
      };
    });
    let command: ProcessSession | undefined;
    const execution = withEnvAsync({ OPENCLAW_EXEC_SHELL_SNAPSHOT: "0" }, () =>
      withExecRequestTurn(
        {
          identity: {
            runId: "parent",
            sessionKey,
            sessionId: "main-session",
            agentId: "main",
            ownerConnId: "owner",
          },
          abortSignal: parent.controller.signal,
        },
        async () => {
          const tool = createLazyExecTool({
            runId: "parent",
            sessionKey,
            sessionId: "main-session",
            agentId: "main",
            config: getRuntimeConfig(),
            cwd: fixture.stateDir,
            scopeKey: sessionKey,
            host: "gateway",
            mode: "full",
            ask: "off",
            allowBackground: true,
            notifyOnExit: false,
            preparedStoreEnvironment: {},
          });
          const result = await tool.execute(
            "ordinary-command",
            {
              command: `node -e "require('fs').watch('.', () => {})"`,
              yieldMs: 10,
              timeoutSeconds: 60,
            },
            parent.controller.signal,
          );
          const details = asOptionalRecord(result.details);
          expect(details?.status).toBe("running");
          if (typeof details?.sessionId !== "string") {
            throw new Error("Expected an ordinary command to yield its process handle");
          }
          command = expectDefined(getSession(details.sessionId), "ordinary command");
          commandReady.resolve();
          await turnAborted.promise;
        },
      ),
    );
    void execution.catch((error: unknown) => commandReady.reject(error));
    let stopping: ReturnType<typeof invokeChatAbortHandler> | undefined;
    try {
      await withinTest(commandReady.promise, signal);
      const respond = vi.fn();
      stopping = invokeChatAbortHandler({
        handler: (options) =>
          handleChatAbortRequestWithLifecycle({
            ...options,
            hasCurrentClientAuthority: () => current,
          }),
        context,
        request: { sessionKey, runId: "parent" },
        client: { connId: "owner", connect: { scopes: ["operator.write"] } },
        respond,
      });
      await withinTest(
        awaitGateBeforeSettlement(
          cleanupEntered.promise,
          stopping,
          "Stop returned before accepted command cleanup",
        ),
        signal,
      );
      expect(rootExitObserved).toBe(true);
      expect(respond).not.toHaveBeenCalled();
      releaseCleanup.resolve();
      await stopping;
      await execution;
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
      expect(respond.mock.calls[0]?.[2]?.message).toContain(
        "command cleanup could not be confirmed",
      );
      expect(command).toMatchObject({
        exited: true,
        exitReason: "manual-cancel",
        finalizationFailed: true,
      });
      expect(parent.controller.signal.aborted).toBe(true);
      expect(persist).toHaveBeenCalledOnce();
      expect(persist.mock.calls[0]?.[0].snapshots.map((snapshot) => snapshot.runId)).toEqual([
        "parent",
      ]);
      expect((await getSubagentRunByChildSessionKey(childKey))?.execution.endedAt).toBeUndefined();
      expect(start).not.toHaveBeenCalled();
      releaseSwarmRun("held-capacity");
      await started.promise;
      expect(start).toHaveBeenCalledOnce();
    } finally {
      releaseCleanup.resolve();
      turnAborted.resolve();
      managedCommand?.cancel("manual-cancel");
      if (command) {
        await waitForExecSession(command);
        deleteSession(command.id);
      }
      await execution.catch(() => {});
      await stopping?.catch(() => {});
      await managedCommand?.wait();
      spawnFailure.mockRestore();
      releaseSwarmRun("held-capacity");
    }
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
    await writeSession(sessionKey, "main-session");
    await writeSession(childKey, "cascade-queued");
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
      await writeSession("agent:main:subagent:orchestrator", "orchestrator");
      await registerSubagentRun({
        runId: "orchestrator",
        childSessionKey: "agent:main:subagent:orchestrator",
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        requesterTurnRunId: "run-mine",
        requesterDisplayKey: sessionKey,
        task: "live orchestrator",
        cleanup: "keep",
        collect: true,
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
            (await getSubagentRunByChildSessionKey("agent:main:subagent:orchestrator"))?.execution
              .endedAt,
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
      const child = await getSubagentRunByChildSessionKey(childKey);
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
