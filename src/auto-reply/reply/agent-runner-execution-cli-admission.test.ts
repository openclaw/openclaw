import { DatabaseSync } from "node:sqlite";
import { assert, expect, it, onTestFinished, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { buildPreparedCliRunContext } from "../../agents/cli-runner.test-helpers.js";
import { buildCliRunResult } from "../../agents/cli-runner/cli-run-settlement.js";
import { executeDeps } from "../../agents/cli-runner/execute-deps.js";
import { executePreparedCliRun } from "../../agents/cli-runner/execute.js";
import { buildCliMcpGrantContext } from "../../agents/cli-runner/mcp-grant-context.js";
import { admitCliRunParams } from "../../agents/cli-runner/run-admission.js";
import { prepareCliRunTerminalReply } from "../../agents/cli-runner/terminal-reply.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import { GENERIC_EXTERNAL_RUN_FAILURE_TEXT } from "../../agents/failover/user-copy.js";
import {
  installSessionPlacementAdmissionProvider,
  type SessionPlacementAdmissionProvider,
} from "../../agents/session-placement-admission.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { resolveSqliteScope } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createFollowupRun,
  expectMockCallArgFields,
  runInitialFallbackAttempt,
  fallbackAttemptOptions,
  createMinimalRunAgentTurnParams,
  makeTestSessionStorePath,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();
const executeAgentTurn = await getExecuteAgentTurnForTest();
const CLI = { provider: "claude-cli", model: "claude-sonnet-4-6" } as const;

function boundReply<T extends { sessionId: string }>(binding: T) {
  return {
    payloads: [{ text: "done" }],
    meta: { agentMeta: { sessionId: binding.sessionId, cliSessionBinding: binding } },
  };
}

function cliResult(text: string, sessionId: string, bindingFlushOk: boolean) {
  const context = buildPreparedCliRunContext();
  const output = { text };
  return buildCliRunResult({
    context,
    output,
    preparedReply: prepareCliRunTerminalReply(context, output),
    effectiveCliSessionId: sessionId,
    bindingFlushOk,
    usedHistoryPrompt: false,
    userTurnHandled: true,
    sessionBindingDisabled: false,
    preparedContextAgentMeta: {},
  });
}

function createCliFollowupRun() {
  const followupRun = createFollowupRun();
  followupRun.run.provider = "claude-cli";
  followupRun.run.model = "claude-sonnet-4-6";
  state.isCliProviderMock.mockImplementation((provider) => provider === "claude-cli");
  return followupRun;
}

async function sessionFixture(
  sessionKey: string,
  fields: Partial<SessionEntry>,
  storedBindings = fields.cliSessionBindings,
) {
  const storePath = makeTestSessionStorePath();
  const entry: SessionEntry = { sessionId: "session", updatedAt: 1, ...fields };
  const scope = { sessionKey, storePath };
  await replaceSessionEntry(scope, { ...entry, cliSessionBindings: storedBindings });
  const followupRun = createCliFollowupRun();
  return {
    scope,
    entry,
    followupRun,
    readBinding: () => loadSessionEntry(scope)?.cliSessionBindings?.["claude-cli"],
    turn: {
      ...createMinimalRunAgentTurnParams({ followupRun }),
      ...scope,
      activeSessionStore: { [sessionKey]: entry },
      getActiveSessionEntry: () => entry,
    },
  };
}

function useCliFallback() {
  state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
    result: await runInitialFallbackAttempt(params, CLI.provider, CLI.model),
    ...CLI,
    attempts: [],
  }));
}

function placement(
  executeLocalTurn: SessionPlacementAdmissionProvider["executeLocalTurn"] = async (
    _claim,
    runLocal,
  ) => runLocal(),
): SessionPlacementAdmissionProvider {
  return {
    assertCompactionSuccessorAllowed: rejectUnexpectedCompactionSuccessor,
    executeLocalTurn,
    executeTurn: async (_claim, _params, runLocal) => runLocal(),
  };
}

function rejectUnexpectedCompactionSuccessor(): never {
  throw new Error("Unexpected compaction successor during CLI admission test");
}

it("reads cold CLI fallback metadata while another connection holds a shared-state write transaction", async () => {
  const sessionKey = "agent:main:cli-read-contention";
  const binding = { sessionId: "existing-native-session" };
  const { scope, turn } = await sessionFixture(sessionKey, {
    lifecycleRevision: "current",
    cliSessionBindings: { "claude-cli": binding },
  });
  useCliFallback();
  let holder: DatabaseSync | undefined;
  state.runCliAgentMock.mockImplementationOnce(async () => {
    expect(holder?.isTransaction).toBe(true);
    holder?.exec("ROLLBACK");
    return boundReply(binding);
  });
  const uninstall = installSessionPlacementAdmissionProvider(
    placement(async (_claim, runLocal) => {
      await closeOpenClawAgentDatabaseByPathAsync(
        resolveOpenClawAgentSqlitePath(resolveSqliteScope(scope)),
      );
      // Ordinary writes now coordinate on the real shared database, not a sidecar.
      holder = new DatabaseSync(resolveOpenClawStateSqlitePath());
      holder.exec("BEGIN IMMEDIATE");
      try {
        expect(() => loadSessionEntry(scope)).toThrow(/database is locked/iu);
        return await runLocal();
      } finally {
        if (holder?.isTransaction) {
          holder.exec("ROLLBACK");
        }
        holder?.close();
      }
    }),
  );
  onTestFinished(uninstall);
  const result = await executeAgentTurn(turn);
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
  const rejected = kind === "rejected" || kind === "rejected-clear";
  const revisionChanged = kind === "revised" || kind === "revision-established";
  const placementRetired = kind === "retired-placement";
  const binding = { sessionId: "admitted-native-session", authProfileId: "anthropic:cli" };
  const settledBinding = { ...binding, sessionId: "settled-native-session" };
  const { scope, entry, followupRun, turn, readBinding } = await sessionFixture(
    sessionKey,
    kind === "revised" ? { lifecycleRevision: "original" } : {},
    { "claude-cli": binding },
  );
  if (kind === "preserved") {
    followupRun.run.inputProvenance = {
      kind: "inter_session",
      sourceTool: "exec_approval_followup",
    };
  }
  state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
    const first = await runInitialFallbackAttempt(params, CLI.provider, CLI.model);
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
      ...CLI,
      attempts: [],
    };
  });
  const candidateResult = boundReply(settledBinding);
  state.runCliAgentMock.mockResolvedValueOnce(
    rejected
      ? cliResult(
          GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
          settledBinding.sessionId,
          kind !== "rejected-clear",
        )
      : candidateResult,
  );
  state.runEmbeddedAgentMock.mockResolvedValueOnce({
    payloads: [{ text: "fallback done" }],
    meta: {},
  });
  let observedBinding: unknown;
  const uninstall = installSessionPlacementAdmissionProvider(
    placement(async (_claim, runLocal) => {
      if (revisionChanged) {
        // Mutating the prepared object must not change the captured admission revision.
        entry.lifecycleRevision = "replacement";
        await replaceSessionEntry(scope, {
          ...entry,
          cliSessionBindings: { "claude-cli": binding },
        });
      }
      const execution = runLocal();
      if (placementRetired) {
        uninstall();
      }
      const result = await execution;
      observedBinding = readBinding();
      return result;
    }),
  );
  onTestFinished(uninstall);
  const result = await executeAgentTurn({
    ...turn,
    isHeartbeat: kind === "heartbeat",
  });
  if (revisionChanged || placementRetired) {
    expect(result.kind).toBe("final");
    expect(state.runCliAgentMock).not.toHaveBeenCalled();
    expect(readBinding()).toEqual(binding);
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
});

it.each(["success", "claim-aborted", "successor-aborted", "restore-aborted"])(
  "honors a forked child's one-shot marker and current owner (%s)",
  async (operation) => {
    const sessionKey = "agent:main:cli-fork-child";
    const parentBinding = {
      sessionId: "parent-native-session",
      resumeCheckpointId: "parent-checkpoint",
      forkNextResume: true as const,
    };
    const controller = new AbortController();
    const abortError = new DOMException("fork cancelled", "AbortError");
    const successorBinding = { sessionId: "child-native-session" };
    const { turn, readBinding } = await sessionFixture(sessionKey, {
      cliSessionBindings: { "claude-cli": parentBinding },
    });
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
    useCliFallback();
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
      return boundReply(successorBinding);
    });
    const uninstall = installSessionPlacementAdmissionProvider(placement());
    onTestFinished(uninstall);
    const result = await executeAgentTurn({
      ...turn,
      opts: { abortSignal: controller.signal },
    });
    expect(state.runCliAgentMock).toHaveBeenCalledTimes(1);
    if (operation !== "success") {
      expect(readBinding()).toEqual(parentBinding);
      return;
    }
    expect(result.kind).toBe("success");
    expect(readBinding()).toMatchObject({ sessionId: successorBinding.sessionId });
    expect(readBinding()?.forkNextResume).toBeUndefined();
  },
);

it.each(["ordinary", "rejected-clear", "room-event"] as const)(
  "retains the %s reply after its continuity write loses ownership",
  async (kind) => {
    const sessionKey = "agent:main:cli-owner-loss";
    const binding = { sessionId: "previous-native-session" };
    const { turn, readBinding } = await sessionFixture(sessionKey, {
      cliSessionBindings: { "claude-cli": binding },
    });
    if (kind === "room-event") {
      turn.followupRun.currentInboundEventKind = "room_event";
    }
    const candidate = cliResult(
      kind === "rejected-clear" ? GENERIC_EXTERNAL_RUN_FAILURE_TEXT : "Captured reply",
      "replacement-native-session",
      kind !== "rejected-clear",
    );
    const provider = placement();
    const uninstall = installSessionPlacementAdmissionProvider(provider);
    let uninstallReplacement: (() => void) | undefined;
    state.runCliAgentMock.mockImplementationOnce(async () => {
      uninstallReplacement = installSessionPlacementAdmissionProvider({ ...provider });
      return candidate;
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = await runInitialFallbackAttempt(params, CLI.provider, CLI.model);
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
      return { result, ...CLI, attempts: [] };
    });
    onTestFinished(() => {
      uninstallReplacement?.();
      uninstall();
    });
    await executeAgentTurn(turn);
    expect(state.runCliAgentMock).toHaveBeenCalledOnce();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(readBinding()).toEqual(binding);
  },
);

it("carries the admitted session permission and placement into the CLI grant", async () => {
  useCliFallback();
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
  Object.freeze(admittedSessionEntry);
  state.runCliAgentMock.mockImplementationOnce(async (run: RunCliAgentParams) => {
    const candidateEntry: InternalSessionEntry | undefined = run.sessionEntry;
    assert(candidateEntry, "Missing admitted CLI entry");
    candidateEntry.activeWriterRunId = "cli-writer";
    expect(run).toMatchObject({
      sessionEntry: { ...admittedSessionEntry, activeWriterRunId: "cli-writer" },
      cliSessionId: "new-native-session",
      cliSessionBinding: { sessionId: "new-native-session", forceReuse: true },
    });
    expect(admittedSessionEntry).not.toHaveProperty("activeWriterRunId");
    const observedCliSessionId = run.cliSessionBinding?.sessionId ?? run.cliSessionId;
    assert(observedCliSessionId === "new-native-session");
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
      ...(await admitCliRunParams(run, "main")),
      skillsSnapshot: undefined,
    };
    prepared.cwd = run.cwd;
    prepared.reusableCliSession = { mode: "reuse", sessionId: observedCliSessionId };
    executeDeps.invokeNodeClaudeCliRun = nodeInvoke;
    try {
      await executePreparedCliRun(prepared, observedCliSessionId);
    } finally {
      executeDeps.invokeNodeClaudeCliRun = restoreNodeInvoke;
    }
    expect(nodeInvoke).toHaveBeenCalledOnce();
    return { payloads: [{ text: "done" }], meta: {} };
  });
  const followupRun = createCliFollowupRun();
  state.isCliProviderMock.mockReturnValue(true);
  const restoreAdmission = installSessionPlacementAdmissionProvider(
    placement(async (_claim, runLocal) => {
      sessionEntry = admittedSessionEntry;
      return await runLocal();
    }),
  );

  onTestFinished(restoreAdmission);
  const result = await executeAgentTurn({
    ...createMinimalRunAgentTurnParams({ followupRun }),
    getActiveSessionEntry: () => sessionEntry,
  });

  expect(state.runCliAgentMock).toHaveBeenCalledOnce();
  await state.runCliAgentMock.mock.results[0]?.value;
  expect(result.kind).toBe("success");
});
