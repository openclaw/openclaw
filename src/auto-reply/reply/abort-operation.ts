import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  captureSessionMcpRuntimeRetirement,
  retireSessionMcpRuntime,
} from "../../agents/agent-bundle-mcp-manager-api.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { captureExecRequestCancellation } from "../../agents/bash-process-control.js";
import { captureExecRequestSubagentSelection } from "../../agents/subagents/registry/subagent-control-scope.js";
import { killAllControlledSubagentRuns } from "../../agents/subagents/registry/subagent-control.js";
import type { SubagentRequestSessionOrigin } from "../../agents/subagents/registry/subagent-exec-request-ownership.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../agents/tools/sessions-helpers.js";
import { readChannelContextGatewayContextResolver } from "../../channels/message-access/admission-evidence.js";
import { resolveSessionStorePathCore } from "../../config/sessions.js";
import {
  markSessionAbortTarget,
  resolveSessionAbortTarget,
  type SessionAbortTargetIdentity,
} from "../../config/sessions/session-accessor.js";
import { normalizeStoreSessionKey } from "../../config/sessions/store-entry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ExecRequestIdentity } from "../../infra/exec-request-context.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  isAcpSessionKey,
  isSubagentSessionKey,
  normalizeAgentId,
} from "../../routing/session-key.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { captureSessionControllerSourceStopAcknowledgment } from "../../sessions/session-controller.mailbox-source.js";
import type { SessionControllerInput } from "../../sessions/session-controller.mailbox.js";
import { getAttachedBackend } from "../../sessions/session-controller.state.js";
import {
  captureSessionControllerStop,
  captureSessionControllerStopCandidates,
  stopSession,
  type SessionControllerStopCapture,
  type SessionStopHookContext,
  type SessionStopRequest,
} from "../../sessions/session-controller.stop.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveCommandAuthorizationAsync } from "../command-auth.js";
import { resolveAbortCutoffFromContext, shouldPersistAbortCutoff } from "./abort-cutoff.js";
import { setAbortMemory } from "./abort-primitives.js";
import { completeAbortRetirements } from "./abort-retirements.js";
import type { FastAbortRequestParams, FastAbortResult, PreparedFastAbortRequest } from "./abort.js";
import { resolveEffectiveResetTargetSessionKey } from "./acp-reset-target.js";
import { resolveSessionConversationBindingContext } from "./session-conversation-binding.js";

type ChannelStopTarget = SessionControllerInput | ReplyOperation;
export type ChannelStopCapture = {
  controller: SessionControllerStopCapture;
  sessionId?: string;
  mcpSessionIds: ReadonlyMap<ChannelStopTarget, readonly string[]>;
  idleMcpRetirements: readonly NonNullable<ReturnType<typeof captureSessionMcpRuntimeRetirement>>[];
  commands: readonly ReturnType<typeof captureExecRequestCancellation>[];
  requestRunIds: ReadonlySet<string>;
};

function matchesStopCandidate(
  candidate: Pick<
    ReturnType<typeof captureSessionControllerStopCandidates>[number],
    "aliases" | "agentId" | "storeScope"
  >,
  params: { key: string; storePath: string; agentId?: string },
): boolean {
  if (!candidate.aliases.has(params.key)) {
    return false;
  }
  if (candidate.storeScope && candidate.storeScope !== params.storePath) {
    return false;
  }
  return (
    !candidate.agentId ||
    !params.agentId ||
    normalizeAgentId(candidate.agentId) === normalizeAgentId(params.agentId)
  );
}

/** Physical identity and runtime references are captured together, before channel I/O. */
export function captureChannelSessionStop(params: {
  key?: string;
  sessionId?: string;
  storePath: string;
  agentId?: string;
  aliases?: readonly (string | undefined)[];
  includeQueued?: boolean;
  resolveGatewayContext?: GatewayContextResolver;
}): ChannelStopCapture {
  const key = normalizeOptionalString(params.key);
  const candidates = key
    ? captureSessionControllerStopCandidates({
        resolveGatewayContext: params.resolveGatewayContext,
      }).filter((candidate) =>
        matchesStopCandidate(candidate, {
          key,
          storePath: params.storePath,
          agentId: params.agentId,
        }),
      )
    : [];
  const controller = captureSessionControllerStop({
    targets: key
      ? [
          captureSessionTarget({
            storeScope: params.storePath,
            sessionKey: key,
            incarnation: params.sessionId,
            agentId: params.agentId,
            aliases: params.aliases,
          }),
        ]
      : [],
    inputs: candidates.flatMap((candidate) => candidate.capture.inputs),
    operations: candidates.flatMap((candidate) => candidate.capture.operations),
    includeQueued: params.includeQueued,
    resolveGatewayContext: params.resolveGatewayContext,
  });
  return captureChannelStopResources(controller, params.sessionId, {
    sessionKey: key,
    sessionId: params.sessionId,
    agentId: params.agentId,
  });
}

function captureChannelStopResources(
  controller: SessionControllerStopCapture,
  capturedSessionId?: string,
  commandTarget?: ExecRequestIdentity,
): ChannelStopCapture {
  const selectedSessionId =
    controller.activeInputs[0]?.claim?.operation?.sessionId ??
    controller.operations[0]?.sessionId ??
    capturedSessionId;
  const mcpSessionIds = new Map<ChannelStopTarget, readonly string[]>();
  for (const operation of controller.operations) {
    mcpSessionIds.set(operation, [...operation.captureOwnedSessionIds()]);
  }
  for (const input of controller.activeInputs) {
    const sessionId = input.source?.run.sessionId ?? capturedSessionId;
    mcpSessionIds.set(
      input,
      input.claim?.operation
        ? [...input.claim.operation.captureOwnedSessionIds()]
        : sessionId
          ? [sessionId]
          : [],
    );
  }
  const active = controller.activeInputs.length > 0 || controller.operations.length > 0;
  const idleMcpRetirement = active
    ? undefined
    : captureSessionMcpRuntimeRetirement({
        sessionId: capturedSessionId,
        sessionKey: commandTarget?.sessionKey,
      });
  const operations = [
    ...controller.operations,
    ...controller.activeInputs.flatMap((input) => input.claim?.operation ?? []),
  ];
  const commands = [
    ...(commandTarget
      ? [
          captureExecRequestCancellation({
            ...commandTarget,
            sessionId: commandTarget.sessionId ?? selectedSessionId,
          }),
        ]
      : []),
    ...operations.map((operation) =>
      captureExecRequestCancellation({
        sessionKey: operation.key,
        sessionId: operation.sessionId,
        agentId: operation.agentId,
      }),
    ),
  ];
  return {
    controller,
    sessionId: selectedSessionId,
    mcpSessionIds,
    idleMcpRetirements: idleMcpRetirement ? [idleMcpRetirement] : [],
    commands,
    requestRunIds: new Set([
      ...commands.flatMap((command) => command.requestRunIds),
      ...operations.flatMap((operation) => getAttachedBackend(operation)?.runId ?? []),
      ...controller.effects.flatMap((effect) => effect.run?.runId ?? []),
    ]),
  };
}

function combineChannelStopCaptures(captures: readonly ChannelStopCapture[]): ChannelStopCapture {
  return {
    controller: captureSessionControllerStop({
      inputs: captures.flatMap((capture) => [...capture.controller.inputs]),
      operations: captures.flatMap((capture) => [...capture.controller.operations]),
      effects: captures.flatMap((capture) => [...capture.controller.effects]),
      pendingCaptures: captures.map((capture) => capture.controller),
    }),
    mcpSessionIds: new Map(captures.flatMap((capture) => [...capture.mcpSessionIds])),
    idleMcpRetirements: captures.flatMap((capture) =>
      capture.idleMcpRetirements.filter((retirement) => retirement.sessionId === capture.sessionId),
    ),
    commands: captures.flatMap((capture) => capture.commands),
    requestRunIds: new Set(captures.flatMap((capture) => [...capture.requestRunIds])),
  };
}

/** Scope adapter only: cancellation and acceptance belong to the captured Stop kernel. */
export function abortSessionRunTargetWithOutcome(params: {
  capture: ChannelStopCapture | (() => ChannelStopCapture);
  assertCurrent?: () => void;
  afterQueued?: () => void;
  hookContext: SessionStopHookContext;
  messageIdentity?: unknown;
  recordAbortTarget?: SessionStopRequest["recordAbortTarget"];
  stopChildren?: SessionStopRequest["stopChildren"];
  retirements: Promise<void>[];
}) {
  let selectedCapture: ChannelStopCapture | undefined;
  const resolveCapture = () =>
    (selectedCapture ??= typeof params.capture === "function" ? params.capture() : params.capture);
  const retiring = new Set<string>();
  const trackRetirement = (sessionId: string, start: () => Promise<void>) => {
    if (retiring.has(sessionId)) {
      return;
    }
    params.assertCurrent?.();
    retiring.add(sessionId);
    const retirement = start();
    void retirement.catch(() => {});
    params.retirements.push(retirement);
  };
  const retire = (sessionIds: readonly string[]) => {
    for (const sessionId of sessionIds) {
      trackRetirement(sessionId, async () => {
        const retired = await retireSessionMcpRuntime({
          sessionId,
          reason: "session-stop",
          preserveActiveLeases: true,
        });
        if (!retired) {
          throw new Error("Session MCP runtime retirement failed.");
        }
      });
    }
  };
  return stopSession({
    source: "channel-user",
    capture: () => resolveCapture().controller,
    assertCurrent: params.assertCurrent,
    hookContext: params.hookContext,
    messageIdentity: params.messageIdentity,
    recordAbortTarget: params.recordAbortTarget,
    stopChildren: params.stopChildren,
    externalParent: {
      stop: () => {
        let aborted = false;
        for (const commands of resolveCapture().commands) {
          params.assertCurrent?.();
          aborted = commands.cancel() || aborted;
        }
        return aborted ? "aborted" : "unchanged";
      },
      get settled() {
        const settlement = Promise.all(
          resolveCapture().commands.map((commands) => commands.settle()),
        ).then(() => undefined);
        params.retirements.push(settlement);
        return settlement;
      },
    },
    afterQueued: () => {
      const capture = resolveCapture();
      params.afterQueued?.();
      for (const retirement of capture.idleMcpRetirements) {
        trackRetirement(retirement.sessionId, () =>
          retirement.retire(() => params.assertCurrent?.()),
        );
      }
    },
    onCancelled: (target) => {
      const capture = resolveCapture();
      // Raw preparation and active producers retain custody after the Stop acknowledgment.
      if (!capture.mcpSessionIds.has(target) && "mailbox" in target) {
        params.retirements.push(captureSessionControllerSourceStopAcknowledgment(target));
      }
      retire(capture.mcpSessionIds.get(target) ?? []);
    },
  });
}

type RequesterSession = Pick<
  SubagentRequestSessionOrigin["target"],
  "storePath" | "sessionId" | "lifecycleRevision"
>;

export async function stopSubagentsForRequester(params: {
  cfg: OpenClawConfig;
  requesterSessionKey?: string;
  requesterAgentId?: string;
  requesterSession?: RequesterSession;
  prepareRequesterSession?: () => Promise<RequesterSession | undefined>;
  assertCurrent?: () => void;
  acceptsRequest?: (identity: ExecRequestIdentity) => boolean;
  beforeKill?: Parameters<typeof killAllControlledSubagentRuns>[0]["beforeKill"];
}): Promise<{ stopped: number; failed: number; execAborted?: boolean }> {
  const cleaned = normalizeOptionalString(params.requesterSessionKey);
  if (!cleaned) {
    params.assertCurrent?.();
    await params.beforeKill?.(() => {});
    return { stopped: 0, failed: 0 };
  }
  const { alias } = resolveMainSessionAlias(params.cfg);
  const requesterKey = resolveInternalSessionKey({ key: cleaned, alias });
  const controllerAgentId = resolveSessionAgentId({
    config: params.cfg,
    sessionKey: requesterKey,
    fallbackAgentId: params.requesterAgentId,
  });
  const controller = {
    controllerSessionKey: requesterKey,
    controllerAgentId,
    callerSessionKey: requesterKey,
    callerIsSubagent: isSubagentSessionKey(requesterKey),
    controlScope: "children" as const,
  };
  const commands = captureExecRequestCancellation({
    sessionKey: requesterKey,
    agentId: controllerAgentId,
  });
  const selectionParams = {
    cfg: params.cfg,
    controller,
    owners: commands.owners,
    acceptsRequest: params.acceptsRequest,
  };
  const sessionOrigin = (session: RequesterSession | undefined) =>
    session
      ? {
          target: { ...session, sessionKey: requesterKey, agentId: controllerAgentId },
          acceptsRequest: () => true,
        }
      : undefined;
  const preparation = params.prepareRequesterSession;
  let selected = captureExecRequestSubagentSelection({
    ...selectionParams,
    sessionOrigin: sessionOrigin(params.requesterSession),
    candidateOrigin: preparation
      ? {
          target: { sessionKey: requesterKey, agentId: controllerAgentId },
          acceptsRequest: () => true,
        }
      : undefined,
  });
  const requestSelection = {
    runs: selected.runs,
    ownsRoot: (entry: (typeof selected.runs)[number]) => selected.ownsRoot(entry),
    selectPublishedRoot:
      preparation || selected.selectPublishedRoot
        ? (entry: (typeof selected.runs)[number]) => selected.selectPublishedRoot?.(entry) === true
        : undefined,
    get sessionGeneration() {
      return selected.sessionGeneration;
    },
    prepare: preparation
      ? async () => {
          selected = captureExecRequestSubagentSelection({
            ...selectionParams,
            sessionOrigin: sessionOrigin(await preparation()),
          });
        }
      : undefined,
  };
  const result = await killAllControlledSubagentRuns({
    cfg: params.cfg,
    controller,
    runs: requestSelection.runs,
    requestSelection,
    assertCurrent: params.assertCurrent,
    suppressTaskDelivery: true,
    beforeKill: params.beforeKill,
  });
  if (result.status === "error") {
    logVerbose(`abort: failed to stop subagents for ${requesterKey}: ${result.error}`);
  }
  return {
    stopped: result.killed,
    failed: result.status === "error" ? result.failed : 0,
    ...(result.execAborted ? { execAborted: true } : {}),
  };
}

export async function executeFastAbortRequest(
  params: FastAbortRequestParams,
  request: PreparedFastAbortRequest,
): Promise<FastAbortResult> {
  const { ctx, cfg } = params;
  const { commandSessionKey, targetKey, resolveTargetAgentId } = request;
  const agentId = resolveTargetAgentId();
  const resolveGatewayContext =
    readChannelContextGatewayContextResolver(ctx) ??
    getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
  const assertCurrent = () => {
    if (params.isCommandTargetCurrent?.sessionSource?.assertScopeCurrent) {
      params.isCommandTargetCurrent.sessionSource.assertScopeCurrent();
      return;
    }
    if (params.isCommandTargetCurrent?.() === false) {
      throw new Error("The selected session changed before it could be stopped.");
    }
  };

  if (targetKey) {
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
    const resolvedTargetKey = normalizeStoreSessionKey(targetKey);
    const captureTarget = (key: string) => {
      const targetAgentId =
        key === resolvedTargetKey
          ? agentId
          : resolveSessionAgentId({ config: cfg, sessionKey: key, fallbackAgentId: ctx.AgentId });
      return captureChannelSessionStop({
        key,
        agentId: targetAgentId,
        resolveGatewayContext,
        storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: targetAgentId }),
      });
    };
    // Capture process owners before metadata or channel routing can yield.
    const mainCapture = captureTarget(resolvedTargetKey);
    const sourceCapture =
      commandSessionKey && commandSessionKey !== resolvedTargetKey
        ? captureTarget(commandSessionKey)
        : undefined;
    const boundCandidates = captureSessionControllerStopCandidates({ resolveGatewayContext }).map(
      (candidate) => ({
        aliases: candidate.aliases,
        agentId: candidate.agentId,
        storeScope: candidate.storeScope,
        channel: captureChannelStopResources(candidate.capture),
      }),
    );
    const targetRead = resolveSessionAbortTarget({
      agentId,
      sessionKey: targetKey,
      storePath,
    }).catch((error: unknown) => {
      logVerbose(
        `abort: failed to resolve abort metadata for ${targetKey}: ${formatErrorMessage(error)}`,
      );
      return null;
    });
    const selection: { target: SessionAbortTargetIdentity | null } = { target: null };
    const retirements: Promise<void>[] = [];
    let selectedCapture = mainCapture;
    let authorized = false;
    const stopState: { execution?: ReturnType<typeof abortSessionRunTargetWithOutcome> } = {};
    const abortCutoff = shouldPersistAbortCutoff({
      commandSessionKey,
      targetSessionKey: resolvedTargetKey,
    })
      ? resolveAbortCutoffFromContext(ctx)
      : undefined;
    const childrenCompleted =
      createDeferredCore<Awaited<ReturnType<typeof stopSubagentsForRequester>>>();
    void childrenCompleted.promise.catch(() => {});
    const { children, executionOutcome } = await completeAbortRetirements(async () => {
      try {
        const stoppedChildren = await stopSubagentsForRequester({
          cfg,
          requesterSessionKey: targetKey,
          requesterAgentId: agentId,
          prepareRequesterSession: async () => {
            selection.target = await targetRead;
            if (
              mainCapture.controller.activeInputs.length === 0 &&
              mainCapture.controller.operations.length === 0
            ) {
              // Metadata confirms the original MCP capture; never select a runtime after this wait.
              mainCapture.sessionId = selection.target?.sessionId;
            }
            return selection.target?.sessionId
              ? {
                  storePath,
                  sessionId: selection.target.sessionId,
                  lifecycleRevision: selection.target.entry.lifecycleRevision ?? null,
                }
              : undefined;
          },
          acceptsRequest: (identity) =>
            !selection.target || identity.sessionId === selection.target.sessionId,
          assertCurrent,
          beforeKill: async (sealRootSelection) => {
            const auth = await resolveCommandAuthorizationAsync({
              ctx,
              cfg,
              commandAuthorized: ctx.CommandAuthorized,
            });
            authorized = auth.isAuthorizedSender;
            if (!authorized) {
              return false;
            }
            const bindingContext = commandSessionKey
              ? resolveSessionConversationBindingContext(cfg, ctx)
              : undefined;
            const conversationBoundAcpTargetKey =
              commandSessionKey && bindingContext
                ? await resolveEffectiveResetTargetSessionKey({
                    cfg,
                    ...bindingContext,
                    activeSessionKey: commandSessionKey,
                    skipConfiguredFallbackWhenActiveSessionNonAcp: false,
                    fallbackToActiveAcpWhenUnbound: false,
                  })
                : undefined;
            const captures = [mainCapture];
            const boundKey = !isAcpSessionKey(resolvedTargetKey)
              ? conversationBoundAcpTargetKey
              : undefined;
            if (boundKey && boundKey !== resolvedTargetKey) {
              const boundAgentId = resolveSessionAgentId({ config: cfg, sessionKey: boundKey });
              const boundStorePath = resolveSessionStorePathCore(cfg.session?.store, {
                agentId: boundAgentId,
              });
              captures.push(
                ...boundCandidates
                  .filter((candidate) =>
                    matchesStopCandidate(candidate, {
                      key: boundKey,
                      storePath: boundStorePath,
                      agentId: boundAgentId,
                    }),
                  )
                  .map((candidate) => candidate.channel),
              );
            }
            if (
              sourceCapture &&
              conversationBoundAcpTargetKey &&
              (conversationBoundAcpTargetKey === resolvedTargetKey ||
                conversationBoundAcpTargetKey === boundKey)
            ) {
              captures.push(sourceCapture);
            }
            selectedCapture = combineChannelStopCaptures(captures);
            const current = params.isCommandTargetCurrent?.();
            if (
              (typeof current === "boolean" || current === undefined ? current : await current) ===
              false
            ) {
              throw new Error("The selected session changed before it could be stopped.");
            }
            sealRootSelection();
            const parentApplied = createDeferredCore<boolean>();
            stopState.execution = abortSessionRunTargetWithOutcome({
              capture: selectedCapture,
              assertCurrent,
              retirements,
              stopChildren: async (applyParentStop) => {
                try {
                  parentApplied.resolve(await applyParentStop());
                } catch (error) {
                  parentApplied.reject(error);
                  throw error;
                }
                return await childrenCompleted.promise;
              },
              hookContext: {
                sessionKey: resolvedTargetKey,
                sessionEntry: selection.target?.entry,
                sessionId: mainCapture.sessionId ?? selection.target?.sessionId,
                commandSource: ctx.Surface ?? ctx.Provider ?? ctx.OriginatingChannel,
                senderId: ctx.SenderId,
              },
              messageIdentity: abortCutoff,
              recordAbortTarget: async ({ recordCutoff }) => {
                const writerRunId = selection.target?.entry.activeWriterRunId;
                if (
                  (mainCapture.sessionId &&
                    mainCapture.sessionId !== selection.target?.sessionId) ||
                  (writerRunId && !mainCapture.requestRunIds.has(writerRunId))
                ) {
                  logVerbose(`abort: skipped metadata for a replacement writer on ${targetKey}`);
                  return;
                }
                try {
                  const persisted = await markSessionAbortTarget({
                    isCurrent: params.isCommandTargetCurrent,
                    expectedTarget: selection.target?.entry ?? null,
                    scope: { agentId, sessionKey: targetKey, storePath },
                    resolveAbortCutoff: recordCutoff ? () => abortCutoff : undefined,
                  });
                  if (persisted?.persisted === false) {
                    logVerbose(
                      `abort: failed to persist abort metadata for ${targetKey}: ${persisted.persistenceError ?? "unknown error"}`,
                    );
                  }
                } catch (error) {
                  logVerbose(
                    `abort: failed to persist abort metadata for ${targetKey}: ${formatErrorMessage(error)}`,
                  );
                }
              },
            });
            // The pre-captured subtree proceeds after parent signaling; the Stop owner
            // waits for its result before persistence and command hooks.
            return await parentApplied.promise;
          },
        });
        childrenCompleted.resolve(stoppedChildren);
        const stoppedExecution = await stopState.execution?.completed;
        return { children: stoppedChildren, executionOutcome: stoppedExecution };
      } catch (error) {
        childrenCompleted.reject(error);
        throw error;
      }
    }, retirements);
    if (!authorized || !executionOutcome) {
      return { handled: false, aborted: false };
    }
    const aborted = executionOutcome.aborted || children.execAborted === true;
    const rejectionReason =
      executionOutcome.alreadyFinalizing && !aborted ? "finalizing" : undefined;
    return {
      handled: true,
      aborted,
      ...(rejectionReason ? { rejectionReason } : {}),
      ...(executionOutcome.localModelMayStillBeFinishing
        ? { localModelMayStillBeFinishing: true }
        : {}),
      stoppedSubagents: children.stopped,
      failedSubagents: children.failed,
    };
  }

  const auth = await resolveCommandAuthorizationAsync({
    ctx,
    cfg,
    commandAuthorized: ctx.CommandAuthorized,
  });
  if (!auth.isAuthorizedSender) {
    return { handled: false, aborted: false };
  }
  const abortKey = auth.from ?? auth.to;
  const requesterSessionKey = ctx.SessionKey ?? abortKey;
  if (abortKey) {
    assertCurrent();
    setAbortMemory(abortKey, true);
  }
  const { stopped, failed, execAborted } = await stopSubagentsForRequester({
    cfg,
    requesterSessionKey,
    assertCurrent,
  });
  return {
    handled: true,
    aborted: execAborted === true,
    stoppedSubagents: stopped,
    failedSubagents: failed,
  };
}
