import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { withTestRunAdmission } from "../../agents/admitted-run-context.test-support.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { buildPreparedCliRunContext } from "../../agents/cli-runner.test-helpers.js";
import { buildCliRunResult } from "../../agents/cli-runner/cli-run-settlement.js";
import { executeDeps } from "../../agents/cli-runner/execute-deps.js";
import { executePreparedCliRun } from "../../agents/cli-runner/execute.js";
import { buildCliMcpGrantContext } from "../../agents/cli-runner/mcp-grant-context.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import { GENERIC_EXTERNAL_RUN_FAILURE_TEXT } from "../../agents/failover/user-copy.js";
import { installSessionPlacementAdmissionProvider } from "../../agents/session-placement-admission.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { resolveSqliteScope } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createFollowupRun,
  requireMockCall,
  expectMockCallArgFields,
  initialFallbackAttemptOptions,
  fallbackAttemptOptions,
  createMinimalRunAgentTurnParams,
  makeTestSessionStorePath,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();

function rejectUnexpectedCompactionSuccessor(): never {
  throw new Error("Unexpected compaction successor during CLI admission test");
}

describe("executeAgentTurn: CLI admission", () => {
  it("reads cold CLI fallback metadata while another connection holds a shared-state write transaction", async () => {
    const sessionKey = "agent:main:cli-read-contention";
    const storePath = makeTestSessionStorePath();
    const binding = { sessionId: "existing-native-session" };
    const entry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      lifecycleRevision: "current",
      cliSessionBindings: { "claude-cli": binding },
    };
    await replaceSessionEntry({ sessionKey, storePath }, entry);
    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "claude-sonnet-4-6";
    state.isCliProviderMock.mockImplementation((provider) => provider === "claude-cli");
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run(
        "claude-cli",
        "claude-sonnet-4-6",
        initialFallbackAttemptOptions(params),
      ),
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      attempts: [],
    }));
    let holder: DatabaseSync | undefined;
    state.runCliAgentMock.mockImplementationOnce(async () => {
      expect(holder?.isTransaction).toBe(true);
      holder?.exec("ROLLBACK");
      return {
        payloads: [{ text: "done" }],
        meta: { agentMeta: { sessionId: binding.sessionId, cliSessionBinding: binding } },
      };
    });
    const uninstall = installSessionPlacementAdmissionProvider({
      assertCompactionSuccessorAllowed: rejectUnexpectedCompactionSuccessor,
      executeLocalTurn: async (_claim, runLocal) => {
        await closeOpenClawAgentDatabaseByPathAsync(
          resolveOpenClawAgentSqlitePath(resolveSqliteScope({ sessionKey, storePath })),
        );
        // Ordinary writes now coordinate on the real shared database, not a sidecar.
        holder = new DatabaseSync(resolveOpenClawStateSqlitePath());
        holder.exec("BEGIN IMMEDIATE");
        try {
          expect(() => loadSessionEntry({ sessionKey, storePath })).toThrow(/database is locked/iu);
          return await runLocal();
        } finally {
          if (holder?.isTransaction) {
            holder.exec("ROLLBACK");
          }
          holder?.close();
        }
      },
      executeTurn: async (_claim, _params, runLocal) => await runLocal(),
    });
    try {
      const executeAgentTurn = await getExecuteAgentTurnForTest();
      const result = await executeAgentTurn({
        ...createMinimalRunAgentTurnParams({ followupRun }),
        sessionKey,
        storePath,
        activeSessionStore: { [sessionKey]: entry },
        getActiveSessionEntry: () => entry,
      });
      expect(result).toMatchObject({
        kind: "success",
        runResult: { payloads: [{ text: "done" }] },
      });
      expect(result).not.toHaveProperty("runResult.meta.error");
      expect(state.runCliAgentMock).toHaveBeenCalledOnce();
      expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
        cliSessionId: binding.sessionId,
        cliSessionBinding: binding,
      });
      expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    } finally {
      uninstall();
    }
  });

  it.each([
    "ordinary",
    "heartbeat",
    "preserved",
    "revised",
    "revision-established",
    "retired-placement",
    "rejected",
    "rejected-clear",
  ])("settles the %s reply's native binding before releasing placement", async (kind) => {
    const sessionKey =
      kind === "ordinary"
        ? "main"
        : kind === "heartbeat"
          ? "global"
          : "agent:main:cli-binding-settlement";
    const storePath = makeTestSessionStorePath();
    const entry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      ...(kind === "revised" ? { lifecycleRevision: "original" } : {}),
    };
    const rejected = kind === "rejected" || kind === "rejected-clear";
    const revisionChanged = kind === "revised" || kind === "revision-established";
    const placementRetired = kind === "retired-placement";
    const binding = { sessionId: "admitted-native-session", authProfileId: "anthropic:cli" };
    const settledBinding = { ...binding, sessionId: "settled-native-session" };
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        ...entry,
        cliSessionBindings: { "claude-cli": binding },
      },
    );
    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "claude-sonnet-4-6";
    if (kind === "preserved") {
      followupRun.run.inputProvenance = {
        kind: "inter_session",
        sourceTool: "exec_approval_followup",
      };
    }
    state.isCliProviderMock.mockImplementation((provider) => provider === "claude-cli");
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const first = await params.run(
        "claude-cli",
        "claude-sonnet-4-6",
        initialFallbackAttemptOptions(params),
      );
      if (rejected) {
        expect(first).toMatchObject({
          classification: { code: "generic_external_run_failure" },
        });
        return {
          result: await params.run("openai", "gpt-5.4", fallbackAttemptOptions(params, "format")),
          provider: "openai",
          model: "gpt-5.4",
          attempts: [{ provider: "claude-cli", model: "claude-sonnet-4-6", reason: "format" }],
        };
      }
      return {
        result: first,
        provider: "claude-cli",
        model: "claude-sonnet-4-6",
        attempts: [],
      };
    });
    const candidateResult = {
      payloads: [{ text: "done" }],
      meta: {
        agentMeta: { sessionId: settledBinding.sessionId, cliSessionBinding: settledBinding },
      },
    };
    state.runCliAgentMock.mockResolvedValueOnce(
      rejected
        ? buildCliRunResult({
            context: buildPreparedCliRunContext(),
            output: { text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT },
            effectiveCliSessionId: settledBinding.sessionId,
            bindingFlushOk: kind !== "rejected-clear",
            usedHistoryPrompt: false,
            userTurnHandled: true,
            sessionBindingDisabled: false,
            preparedContextAgentMeta: {},
          })
        : candidateResult,
    );
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "fallback done" }],
      meta: {},
    });
    let observedBinding: unknown;
    const uninstall = installSessionPlacementAdmissionProvider({
      assertCompactionSuccessorAllowed: rejectUnexpectedCompactionSuccessor,
      executeLocalTurn: async (_claim, runLocal) => {
        if (revisionChanged) {
          // Mutating the prepared object must not change the captured admission revision.
          entry.lifecycleRevision = "replacement";
          await replaceSessionEntry(
            { sessionKey, storePath },
            {
              ...entry,
              cliSessionBindings: { "claude-cli": binding },
            },
          );
        }
        const execution = runLocal();
        if (placementRetired) {
          uninstall();
        }
        const result = await execution;
        observedBinding = loadSessionEntry({ sessionKey, storePath })?.cliSessionBindings?.[
          "claude-cli"
        ];
        return result;
      },
      executeTurn: async (_claim, _params, runLocal) => await runLocal(),
    });
    try {
      const executeAgentTurn = await getExecuteAgentTurnForTest();
      const result = await executeAgentTurn({
        ...createMinimalRunAgentTurnParams({ followupRun }),
        sessionKey,
        storePath,
        isHeartbeat: kind === "heartbeat",
        activeSessionStore: { [sessionKey]: entry },
        getActiveSessionEntry: () => entry,
      });
      if (revisionChanged || placementRetired) {
        expect(result.kind).toBe("final");
        expect(state.runCliAgentMock).not.toHaveBeenCalled();
        expect(
          loadSessionEntry({ sessionKey, storePath })?.cliSessionBindings?.["claude-cli"],
        ).toEqual(binding);
        return;
      }
      expect(result.kind).toBe("success");
      expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
        cliSessionId: binding.sessionId,
        cliSessionBinding: binding,
      });
      expect(observedBinding).toEqual(
        kind === "rejected-clear"
          ? undefined
          : kind === "preserved" || rejected
            ? binding
            : settledBinding,
      );
    } finally {
      uninstall();
    }
  });

  it.each(["success", "claim-aborted", "successor-aborted", "restore-aborted"])(
    "honors a forked child's one-shot marker and current owner (%s)",
    async (operation) => {
      const sessionKey = "agent:main:cli-fork-child";
      const storePath = makeTestSessionStorePath();
      const parentBinding = {
        sessionId: "parent-native-session",
        resumeCheckpointId: "parent-checkpoint",
        forkNextResume: true as const,
      };
      const controller = new AbortController();
      const abortError = new DOMException("fork cancelled", "AbortError");
      const successorBinding = { sessionId: "child-native-session" };
      const entry: SessionEntry = {
        sessionId: "session",
        updatedAt: 1,
        cliSessionBindings: { "claude-cli": parentBinding },
      };
      await replaceSessionEntry({ sessionKey, storePath }, entry);
      const followupRun = createFollowupRun();
      followupRun.run.provider = "claude-cli";
      followupRun.run.model = "claude-sonnet-4-6";
      state.isCliProviderMock.mockImplementation((provider) => provider === "claude-cli");
      cliBackendsTesting.setDepsForTest({
        resolvePluginSetupCliBackend: () => undefined,
        resolveRuntimeCliBackends: () => [
          {
            id: "claude-cli",
            modelProvider: "anthropic",
            pluginId: "anthropic",
            config: { command: "claude", forkArg: "--fork-session" },
          },
        ],
      });
      state.runWithModelFallbackMock.mockImplementationOnce(
        async (params: FallbackRunnerParams) => ({
          result: await params.run(
            "claude-cli",
            "claude-sonnet-4-6",
            initialFallbackAttemptOptions(params),
          ),
          provider: "claude-cli",
          model: "claude-sonnet-4-6",
          attempts: [],
        }),
      );
      const readBinding = () =>
        loadSessionEntry({ sessionKey, storePath })?.cliSessionBindings?.["claude-cli"];
      state.runCliAgentMock.mockImplementationOnce(async (params: RunCliAgentParams) => {
        // Mirror the CLI runtime: claim the marker, spawn with the fork flag, then
        // rebind to the successor the CLI reports.
        expect(params.forkCliSessionOnResume).toBe(true);
        const claim = params.claimCliSessionFork?.();
        if (operation === "claim-aborted") {
          controller.abort(abortError);
          await expect(claim).rejects.toThrow("fork cancelled");
          return { meta: { aborted: true, stopReason: "stop" } };
        }
        expect(await claim).toBe(true);
        expect(readBinding()?.forkNextResume).toBeUndefined();
        if (operation === "restore-aborted") {
          controller.abort(abortError);
          await params.restoreCliSessionFork?.();
          return { meta: { aborted: true, stopReason: "stop" } };
        }
        const successor = params.persistCliSessionForkSuccessor?.(successorBinding.sessionId);
        if (operation === "successor-aborted") {
          controller.abort(abortError);
          await expect(successor).rejects.toThrow("fork cancelled");
          await params.restoreCliSessionFork?.();
          return { meta: { aborted: true, stopReason: "stop" } };
        }
        await successor;
        expect(readBinding()).toEqual({
          sessionId: successorBinding.sessionId,
          resumeCheckpointId: parentBinding.resumeCheckpointId,
        });
        return {
          payloads: [{ text: "done" }],
          meta: {
            agentMeta: {
              sessionId: successorBinding.sessionId,
              cliSessionBinding: successorBinding,
            },
          },
        };
      });
      const uninstall = installSessionPlacementAdmissionProvider({
        assertCompactionSuccessorAllowed: rejectUnexpectedCompactionSuccessor,
        executeLocalTurn: async (_claim, runLocal) => await runLocal(),
        executeTurn: async (_claim, _params, runLocal) => await runLocal(),
      });
      try {
        const executeAgentTurn = await getExecuteAgentTurnForTest();
        const result = await executeAgentTurn({
          ...createMinimalRunAgentTurnParams({
            followupRun,
            opts: { abortSignal: controller.signal },
          }),
          sessionKey,
          storePath,
          activeSessionStore: { [sessionKey]: entry },
          getActiveSessionEntry: () => entry,
        });
        expect(state.runCliAgentMock).toHaveBeenCalledTimes(1);
        if (operation !== "success") {
          expect(readBinding()).toEqual(parentBinding);
          return;
        }
        expect(result.kind).toBe("success");
        expect(readBinding()).toMatchObject({ sessionId: successorBinding.sessionId });
        expect(readBinding()?.forkNextResume).toBeUndefined();
      } finally {
        uninstall();
        cliBackendsTesting.resetDepsForTest();
      }
    },
  );

  it.each(["ordinary", "rejected-clear", "room-event"] as const)(
    "retains the %s reply after its continuity write loses ownership",
    async (kind) => {
      const sessionKey = "agent:main:cli-owner-loss";
      const storePath = makeTestSessionStorePath();
      const binding = { sessionId: "previous-native-session" };
      const entry: SessionEntry = {
        sessionId: "session",
        updatedAt: 1,
        cliSessionBindings: { "claude-cli": binding },
      };
      await replaceSessionEntry({ sessionKey, storePath }, entry);
      const followupRun = createFollowupRun();
      followupRun.run.provider = "claude-cli";
      followupRun.run.model = "claude-sonnet-4-6";
      if (kind === "room-event") {
        followupRun.currentInboundEventKind = "room_event";
      }
      state.isCliProviderMock.mockImplementation((provider) => provider === "claude-cli");
      const candidate = buildCliRunResult({
        context: buildPreparedCliRunContext(),
        output: {
          text: kind === "rejected-clear" ? GENERIC_EXTERNAL_RUN_FAILURE_TEXT : "Captured reply",
        },
        effectiveCliSessionId: "replacement-native-session",
        bindingFlushOk: kind !== "rejected-clear",
        usedHistoryPrompt: false,
        userTurnHandled: true,
        sessionBindingDisabled: false,
        preparedContextAgentMeta: {},
      });
      const provider: Parameters<typeof installSessionPlacementAdmissionProvider>[0] = {
        assertCompactionSuccessorAllowed: rejectUnexpectedCompactionSuccessor,
        executeLocalTurn: async (_claim, runLocal) => await runLocal(),
        executeTurn: async (_claim, _params, runLocal) => await runLocal(),
      };
      const uninstall = installSessionPlacementAdmissionProvider(provider);
      let uninstallReplacement: (() => void) | undefined;
      state.runCliAgentMock.mockImplementationOnce(async () => {
        uninstallReplacement = installSessionPlacementAdmissionProvider({ ...provider });
        return candidate;
      });
      state.runWithModelFallbackMock.mockImplementationOnce(
        async (params: FallbackRunnerParams) => {
          const result = await params.run(
            "claude-cli",
            "claude-sonnet-4-6",
            initialFallbackAttemptOptions(params),
          );
          expect(result).toMatchObject({
            classification: null,
            result: {
              payloads: expect.arrayContaining(candidate.payloads ?? []),
              meta: {
                replayInvalid: true,
                error: {
                  message: expect.stringContaining("CLI session continuity could not be saved"),
                  fallbackSafe: false,
                },
              },
            },
          });
          return { result, provider: "claude-cli", model: "claude-sonnet-4-6", attempts: [] };
        },
      );
      try {
        const executeAgentTurn = await getExecuteAgentTurnForTest();
        await executeAgentTurn({
          ...createMinimalRunAgentTurnParams({ followupRun }),
          sessionKey,
          storePath,
          activeSessionStore: { [sessionKey]: entry },
          getActiveSessionEntry: () => entry,
        });
        expect(state.runCliAgentMock).toHaveBeenCalledOnce();
        expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
        expect(
          loadSessionEntry({ sessionKey, storePath })?.cliSessionBindings?.["claude-cli"],
        ).toEqual(binding);
      } finally {
        uninstallReplacement?.();
        uninstall();
      }
    },
  );

  it("carries the admitted session permission and placement into the CLI grant", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run(
        "claude-cli",
        "claude-sonnet-4-6",
        initialFallbackAttemptOptions(params),
      ),
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      attempts: [],
    }));
    let sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      permissionMode: "guarded",
      sessionRoot: "/workspace/old",
      execHost: "gateway",
      cliSessionBindings: {
        "claude-cli": { sessionId: "old-native-session", forceReuse: true },
      },
    };
    const admittedSessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 2,
      permissionMode: "read-only",
      sessionRoot: "/workspace/project",
      execHost: "node",
      execNode: "node-a",
      execCwd: "/workspace/project/task",
      cliSessionBindings: {
        "claude-cli": { sessionId: "new-native-session", forceReuse: true },
      },
    };
    state.runCliAgentMock.mockResolvedValueOnce({ payloads: [{ text: "done" }], meta: {} });
    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "claude-sonnet-4-6";
    const restoreAdmission = installSessionPlacementAdmissionProvider({
      assertCompactionSuccessorAllowed: rejectUnexpectedCompactionSuccessor,
      executeLocalTurn: async (_claim, runLocal) => {
        sessionEntry = admittedSessionEntry;
        return await runLocal();
      },
      executeTurn: async (_claim, _params, runLocal) => await runLocal(),
    });

    try {
      const executeAgentTurn = await getExecuteAgentTurnForTest();
      const result = await executeAgentTurn({
        ...createMinimalRunAgentTurnParams({ followupRun }),
        getActiveSessionEntry: () => sessionEntry,
      });

      expect(result.kind).toBe("success");
      const run = requireMockCall(
        state.runCliAgentMock,
        0,
        "CLI run params",
      )[0] as RunCliAgentParams;
      expect(run.sessionEntry).toBe(admittedSessionEntry);
      expect(run.sessionEntry?.sessionRoot).toBe("/workspace/project");
      expect(run.cliSessionId).toBe("new-native-session");
      expect(run.cliSessionBinding).toMatchObject({
        sessionId: "new-native-session",
        forceReuse: true,
      });
      const observedCliSessionId = run.cliSessionBinding?.sessionId ?? run.cliSessionId;
      expect(observedCliSessionId).toBe("new-native-session");
      if (!observedCliSessionId) {
        throw new Error("expected admitted CLI session binding");
      }
      expect(
        buildCliMcpGrantContext({
          run,
          config: run.config ?? {},
          requireExplicitMessageTarget: false,
          agentId: "main",
          modelProvider: "anthropic",
          modelId: "claude-sonnet-4-6",
        }).execSession,
      ).toMatchObject({
        permissionMode: "read-only",
        execHost: "node",
        execNode: "node-a",
      });

      const nodeInvoke = vi.fn<typeof executeDeps.invokeNodeClaudeCliRun>(async (request) => {
        expect(request.nodeId).toBe("node-a");
        expect(request.argv).toContain("new-native-session");
        expect(request.argv).not.toContain("old-native-session");
        return {
          ok: true,
          payloadJSON: JSON.stringify({ exitCode: 0, stderrTail: "", truncated: false }),
        };
      });
      const restoreNodeInvoke = executeDeps.invokeNodeClaudeCliRun;
      const backend = {
        command: "claude",
        args: ["-p"],
        resumeArgs: ["--resume", "{sessionId}"],
        output: "text" as const,
        input: "stdin" as const,
        serialize: true,
      };
      const prepared = buildPreparedCliRunContext({
        provider: "claude-cli",
        model: run.model,
        runId: run.runId,
        workspaceDir: run.workspaceDir,
        config: run.config,
        sessionEntry: run.sessionEntry,
        backend,
      });
      prepared.params = {
        ...run,
        admittedRunContext: prepared.params.admittedRunContext,
        skillsSnapshot: undefined,
      };
      prepared.cwd = run.cwd;
      prepared.reusableCliSession = { mode: "reuse", sessionId: observedCliSessionId };
      executeDeps.invokeNodeClaudeCliRun = nodeInvoke;
      try {
        await withTestRunAdmission(prepared.params, async (admittedRunContext) => {
          prepared.params.admittedRunContext = admittedRunContext;
          await executePreparedCliRun(prepared, observedCliSessionId);
        });
      } finally {
        executeDeps.invokeNodeClaudeCliRun = restoreNodeInvoke;
      }
      expect(nodeInvoke).toHaveBeenCalledOnce();
    } finally {
      restoreAdmission();
    }
  });
});
