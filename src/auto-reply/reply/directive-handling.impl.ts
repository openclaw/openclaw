import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { renderExecTargetLabel } from "../../agents/bash-tools.exec-runtime.js";
import { resolveExecDefaults } from "../../agents/exec-defaults.js";
import {
  formatFastModeCommandOptions,
  formatFastModeCurrentStatus,
  formatFastModeValue,
  resolveFastModeState,
} from "../../agents/fast-mode.js";
import { persistStickyModelSelectionBestEffort } from "../../agents/sticky-model-selection.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { resolveCollapsedSessionAuthPinSource } from "../../config/sessions/auth-profile-override-provenance.js";
import { triggerSessionPatchHook } from "../../gateway/session-patch-hooks.js";
import { resolveSystemEventQueueKey } from "../../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { prefixSystemMessage } from "../../infra/system-message.js";
import { applyModelOverrideWithAuthProfileCompatibility } from "../../sessions/auth-profile-preservation.js";
import {
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_MESSAGE,
} from "../../sessions/model-overrides.js";
import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { readSessionInputProfileId } from "../../sessions/session-participant-input.js";
import { formatFastModeConfirmation } from "../../shared/fast-mode.js";
import {
  formatThinkingLevels,
  isThinkingLevelSupported,
  resolveSupportedThinkingLevel,
} from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import {
  maybeHandleUnexpectedDirectiveArguments,
  resolveInvalidExecDirectiveMessage,
} from "./directive-handling.arguments.js";
import { applyModelRuntimeDirective } from "./directive-handling.model-runtime.js";
import { resolveModelSelectionFromDirective } from "./directive-handling.model-selection.js";
import { maybeHandleModelDirectiveInfo } from "./directive-handling.model.js";
import type { HandleDirectiveOnlyParams } from "./directive-handling.params.js";
import { maybeHandleQueueDirective } from "./directive-handling.queue-validation.js";
import {
  acknowledgeIgnoredSessionDirective,
  applySessionDirectiveFields,
  canPersistSessionDirectiveDefaults,
  DIRECTIVE_ACK_MESSAGES,
  type IgnoredSessionDirectiveFlag,
  formatElevatedEvent,
  formatElevatedUnavailableText,
  formatModelSelectionScopeAck,
  formatReasoningEvent,
  persistSessionDirectiveSnapshot,
  resolveDirectiveTouchedSessionFields,
  withOptions,
} from "./directive-handling.shared.js";
import { resolveDirectiveRuntimeContext } from "./directive-runtime-context.js";
import type { ThinkLevel } from "./directives.js";
import {
  findSelectedCatalogEntry,
  prepareModelSelectionRuntime,
} from "./model-runtime-normalization.js";
import { refreshQueuedFollowupSession } from "./queue.js";

const LEVEL_QUERY_OPTIONS = {
  Verbose: ["off, on, full", "on, full, off"],
  Trace: ["off, on, raw", "on, off, raw"],
  Reasoning: ["on, off, stream", "on, off, stream"],
} as const;

const ELEVATED_RUNTIME_HINT = prefixSystemMessage("Runtime is direct; sandboxing does not apply.");

export async function handleDirectiveOnly(
  params: HandleDirectiveOnlyParams,
): Promise<ReplyPayload | undefined> {
  const {
    directives,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    elevatedEnabled,
    elevatedAllowed,
    defaultProvider,
    defaultModel,
    aliasIndex,
    allowedModelKeys,
    allowedModelCatalog,
    provider,
    model,
    formatModelSwitchEvent,
    currentThinkLevel,
    currentFastMode,
    currentVerboseLevel,
    currentReasoningLevel,
    currentElevatedLevel,
  } = params;
  const allowPrivilegedPersistence = canPersistSessionDirectiveDefaults(params);
  const rejectModelTransaction = (errorText: string): ReplyPayload => {
    params.onRejection?.();
    if (params.persistenceState) {
      params.persistenceState.outcome = { kind: "rejected", errorText };
    }
    return { text: errorText, isError: true };
  };
  const acknowledgeIgnoredDirective = (
    reply: ReplyPayload | string,
    ignoredDirective: IgnoredSessionDirectiveFlag,
  ) =>
    acknowledgeIgnoredSessionDirective({
      reply: typeof reply === "string" ? { text: reply } : reply,
      directives,
      ignoredDirective,
      persistenceState: params.persistenceState,
      applyRemainingDirectives: (remainingDirectives) =>
        handleDirectiveOnly({ ...params, directives: remainingDirectives }),
    });
  const acknowledgeLevel = (name: keyof typeof LEVEL_QUERY_OPTIONS, currentLevel?: string) => {
    const [validLevels, options] = LEVEL_QUERY_OPTIONS[name];
    const rawLevel = directives[`raw${name}Level`];
    return acknowledgeIgnoredDirective(
      rawLevel
        ? `Unrecognized ${name.toLowerCase()} level "${rawLevel}". Valid levels: ${validLevels}.`
        : withOptions(`Current ${name.toLowerCase()} level: ${currentLevel ?? "off"}.`, options),
      `has${name}Directive`,
    );
  };
  const delegatedTraceAllowed = (params.gatewayClientScopes ?? []).includes("operator.admin");
  if (directives.hasTraceDirective && !params.senderIsOwner && !delegatedTraceAllowed) {
    return acknowledgeIgnoredDirective(
      "❌ /trace is restricted to owners and gateway clients with operator.admin scope.",
      "hasTraceDirective",
    );
  }
  const { activeAgentId, agentDir, runtimePolicySessionKey, runtimeIsSandboxed } =
    resolveDirectiveRuntimeContext(params);
  const shouldHintDirectRuntime = directives.hasElevatedDirective && !runtimeIsSandboxed;
  let thinkingCatalog = params.thinkingCatalog?.length
    ? params.thinkingCatalog
    : allowedModelCatalog.length > 0
      ? allowedModelCatalog
      : undefined;
  const modelInfo = await maybeHandleModelDirectiveInfo({
    ...params,
    agentDir,
    activeAgentId,
    currentThinkLevel: currentThinkLevel ?? "off",
    thinkingCatalog,
    runtimePolicySessionKey,
  });
  if (modelInfo) {
    return acknowledgeIgnoredDirective(modelInfo, "hasModelDirective");
  }

  const modelResolution = await resolveModelSelectionFromDirective({
    directives,
    cfg: params.cfg,
    agentDir,
    defaultProvider,
    defaultModel,
    aliasIndex,
    allowedModelKeys,
    agentId: activeAgentId,
    modelPolicy: params.modelPolicy,
    operatorAuthority: params.operatorAuthority,
    requesterProfileId: params.ctx ? readSessionInputProfileId(params.ctx) : undefined,
  });
  if (modelResolution.errorText) {
    return rejectModelTransaction(modelResolution.errorText);
  }
  const { modelSelection, profileOverride } = modelResolution;
  if (modelSelection && isModelSelectionLocked(sessionEntry)) {
    return rejectModelTransaction(MODEL_SELECTION_LOCKED_MESSAGE);
  }

  const resolvedProvider = modelSelection?.provider ?? provider;
  const resolvedModel = modelSelection?.model ?? model;
  const preparedModel = modelSelection
    ? await prepareModelSelectionRuntime({
        cfg: params.cfg,
        agentId: activeAgentId,
        workspaceDir: params.workspaceDir,
        provider: resolvedProvider,
        model: resolvedModel,
        catalog: thinkingCatalog ?? [],
        rawRuntime: directives.rawModelRuntime,
        sessionEntry,
        profileOverride,
      })
    : undefined;
  if (preparedModel?.status === "rejected") {
    return rejectModelTransaction(preparedModel.message);
  }
  thinkingCatalog = preparedModel?.catalog ?? thinkingCatalog;
  const modelRuntimeResolution = preparedModel?.runtime ?? { kind: "unchanged" as const };
  const validateSelection = () =>
    modelResolution.validateModelSelection?.() ?? preparedModel?.validateRuntimeSelection?.();
  const prospectiveSessionEntry = { ...sessionEntry };
  applyModelRuntimeDirective(prospectiveSessionEntry, modelRuntimeResolution);
  const selectedCatalogEntry = findSelectedCatalogEntry({
    catalog: thinkingCatalog,
    provider: resolvedProvider,
    model: resolvedModel,
  });
  const resolveThinkingRuntime = (entry: typeof sessionEntry) =>
    resolveEffectiveAgentRuntime({
      cfg: params.cfg,
      provider: resolvedProvider,
      modelId: resolvedModel,
      modelApi: selectedCatalogEntry?.api,
      modelBaseUrl: selectedCatalogEntry?.baseUrl,
      agentId: activeAgentId,
      sessionKey: runtimePolicySessionKey,
      sessionEntry: entry,
    });
  const thinkingRuntime = resolveThinkingRuntime(prospectiveSessionEntry);
  const thinkingPolicy = {
    provider: resolvedProvider,
    model: resolvedModel,
    catalog: thinkingCatalog,
    agentRuntime: thinkingRuntime,
  };
  const fastModeState = resolveFastModeState({
    cfg: params.cfg,
    provider: resolvedProvider,
    model: resolvedModel,
    agentId: activeAgentId,
    sessionEntry: directives.clearFastMode ? undefined : sessionEntry,
  });
  const effectiveFastMode =
    directives.fastMode ??
    (directives.clearFastMode ? fastModeState.mode : currentFastMode) ??
    fastModeState.mode;

  if (directives.hasThinkDirective && !directives.thinkLevel && !directives.clearThinkLevel) {
    if (!directives.rawThinkLevel) {
      const level = resolveSupportedThinkingLevel({
        ...thinkingPolicy,
        level: currentThinkLevel ?? "off",
      });
      return acknowledgeIgnoredDirective(
        withOptions(
          `Current thinking level: ${level}.`,
          `default, ${formatThinkingLevels(resolvedProvider, resolvedModel, ", ", thinkingCatalog, thinkingRuntime)}`,
        ),
        "hasThinkDirective",
      );
    }
    return acknowledgeIgnoredDirective(
      `Unrecognized thinking level "${directives.rawThinkLevel}". Valid levels: default, ${formatThinkingLevels(resolvedProvider, resolvedModel, ", ", thinkingCatalog, thinkingRuntime)}.`,
      "hasThinkDirective",
    );
  }
  if (directives.hasVerboseDirective && !directives.verboseLevel) {
    return acknowledgeLevel("Verbose", currentVerboseLevel);
  }
  if (directives.hasTraceDirective && !directives.traceLevel) {
    return acknowledgeLevel("Trace", sessionEntry.traceLevel);
  }
  if (
    directives.hasFastDirective &&
    directives.fastMode === undefined &&
    !directives.clearFastMode
  ) {
    const isFastStatus = normalizeLowercaseStringOrEmpty(directives.rawFastMode) === "status";
    if (!directives.rawFastMode || isFastStatus) {
      const statusText = formatFastModeCurrentStatus({
        mode: effectiveFastMode,
        source: fastModeState.source,
        fastAutoOnSeconds: fastModeState.fastAutoOnSeconds,
      });
      return acknowledgeIgnoredDirective(
        isFastStatus
          ? statusText
          : withOptions(
              statusText,
              formatFastModeCommandOptions({
                fastAutoOnSeconds: fastModeState.fastAutoOnSeconds,
              }),
            ),
        "hasFastDirective",
      );
    }
    return acknowledgeIgnoredDirective(
      `Unrecognized fast mode "${directives.rawFastMode}". Valid levels: on, off, ultrafast, auto, default, status.`,
      "hasFastDirective",
    );
  }
  if (directives.hasReasoningDirective && !directives.reasoningLevel) {
    return acknowledgeLevel("Reasoning", currentReasoningLevel);
  }
  if (directives.hasElevatedDirective) {
    if (!directives.elevatedLevel && directives.rawElevatedLevel) {
      return acknowledgeIgnoredDirective(
        `Unrecognized elevated level "${directives.rawElevatedLevel}". Valid levels: off, on, ask, full.`,
        "hasElevatedDirective",
      );
    }
    if (!elevatedEnabled || !elevatedAllowed) {
      return acknowledgeIgnoredDirective(
        formatElevatedUnavailableText({
          runtimeSandboxed: runtimeIsSandboxed,
          failures: params.elevatedFailures,
          sessionKey: params.sessionKey,
        }),
        "hasElevatedDirective",
      );
    }
    if (!directives.elevatedLevel) {
      const level = currentElevatedLevel ?? "off";
      return acknowledgeIgnoredDirective(
        [
          withOptions(`Current elevated level: ${level}.`, "on, off, ask, full"),
          shouldHintDirectRuntime ? ELEVATED_RUNTIME_HINT : null,
        ]
          .filter(Boolean)
          .join("\n"),
        "hasElevatedDirective",
      );
    }
  }
  if (directives.hasExecDirective) {
    const invalidExecMessage = resolveInvalidExecDirectiveMessage(directives);
    if (invalidExecMessage) {
      return acknowledgeIgnoredDirective(invalidExecMessage, "hasExecDirective");
    }
    const unexpectedExecArguments = maybeHandleUnexpectedDirectiveArguments(directives);
    if (unexpectedExecArguments) {
      params.onRejection?.();
      return unexpectedExecArguments;
    }
    if (!directives.hasExecOptions) {
      const execDefaults = resolveExecDefaults({
        cfg: params.cfg,
        sessionEntry,
        agentId: activeAgentId,
        sandboxAvailable: runtimeIsSandboxed,
      });
      const nodeLabel = execDefaults.node ? `node=${execDefaults.node}` : "node=(unset)";
      return acknowledgeIgnoredDirective(
        withOptions(
          `Current exec defaults: host=${renderExecTargetLabel(execDefaults.host)}, effective=${execDefaults.effectiveHost}, security=${execDefaults.security}, ask=${execDefaults.ask}, ${nodeLabel}.`,
          "host=auto|sandbox|gateway|node, security=deny|allowlist|full, ask=off|on-miss|always, node=<id>",
        ),
        "hasExecDirective",
      );
    }
  }

  const queueAck = maybeHandleQueueDirective({
    directives,
    cfg: params.cfg,
    channel: provider,
    sessionEntry,
  });
  if (queueAck) {
    return acknowledgeIgnoredDirective(queueAck, "hasQueueDirective");
  }

  const unexpectedArguments = maybeHandleUnexpectedDirectiveArguments(directives);
  if (unexpectedArguments) {
    params.onRejection?.();
    return unexpectedArguments;
  }

  if (
    directives.hasThinkDirective &&
    directives.thinkLevel &&
    !isThinkingLevelSupported({
      ...thinkingPolicy,
      level: directives.thinkLevel,
    })
  ) {
    return rejectModelTransaction(
      `Thinking level "${directives.thinkLevel}" is not supported for ${resolvedProvider}/${resolvedModel}. Use one of: ${formatThinkingLevels(resolvedProvider, resolvedModel, ", ", thinkingCatalog, thinkingRuntime)}.`,
    );
  }

  // Model changes normalize stored choices; inherited defaults must remain unpinned.
  const nextThinkLevel = sessionEntry.thinkingLevel as ThinkLevel | undefined;
  const remappedUnsupportedThinkLevel =
    nextThinkLevel && (params.persistenceState ? modelSelection : !directives.hasThinkDirective)
      ? resolveSupportedThinkingLevel({
          ...thinkingPolicy,
          level: nextThinkLevel,
        })
      : undefined;
  const shouldRemapUnsupportedThinkLevel =
    Boolean(remappedUnsupportedThinkLevel) && remappedUnsupportedThinkLevel !== nextThinkLevel;

  const prevReasoningLevel = currentReasoningLevel ?? sessionEntry.reasoningLevel ?? "off";
  const elevatedChanged =
    directives.hasElevatedDirective &&
    directives.elevatedLevel !== undefined &&
    directives.elevatedLevel !== (currentElevatedLevel ?? sessionEntry.elevatedLevel ?? "off") &&
    elevatedEnabled &&
    elevatedAllowed;
  let modelSelectionUpdated = false;
  let configuredDefaultUpdate: ReturnType<typeof persistStickyModelSelectionBestEffort> | undefined;
  const touchedSessionFields = resolveDirectiveTouchedSessionFields({
    directives,
    allowPrivilegedPersistence,
    directiveOnly: !params.persistenceState,
  });
  if (shouldRemapUnsupportedThinkLevel && !touchedSessionFields.includes("thinkingLevel")) {
    touchedSessionFields.push("thinkingLevel");
  }
  const fastModeChanged =
    (directives.hasFastDirective &&
      directives.fastMode !== undefined &&
      directives.fastMode !== currentFastMode) ||
    (directives.clearFastMode && currentFastMode !== fastModeState.mode);
  const reasoningChanged =
    directives.hasReasoningDirective &&
    directives.reasoningLevel !== undefined &&
    directives.reasoningLevel !== prevReasoningLevel;
  // Validated, authorized directives have already named every field they can mutate.
  if (touchedSessionFields.length > 0) {
    const authProfileError = validateSelection();
    if (authProfileError) {
      return rejectModelTransaction(authProfileError);
    }
    const initialSessionEntry = { ...sessionEntry };
    const directiveFieldsUpdated =
      !params.persistenceState &&
      applySessionDirectiveFields({
        directives,
        sessionEntry,
        allowPrivilegedPersistence,
        allowElevatedPersistence: elevatedEnabled && elevatedAllowed,
      });
    if (shouldRemapUnsupportedThinkLevel && remappedUnsupportedThinkLevel) {
      sessionEntry.thinkingLevel = remappedUnsupportedThinkLevel;
    }
    if (modelSelection) {
      const applied = applyModelOverrideWithAuthProfileCompatibility({
        cfg: params.cfg,
        agentDir,
        entry: sessionEntry,
        currentProvider: provider,
        selection: modelSelection,
        explicitDefaultSelection: modelSelection.isDefault,
        profileOverride,
        markLiveSwitchPending: true,
      });
      const appliedRuntime = applyModelRuntimeDirective(sessionEntry, modelRuntimeResolution);
      modelSelectionUpdated = applied.updated || appliedRuntime.updated;
    }
    sessionEntry.updatedAt = Date.now();
    sessionStore[sessionKey] = sessionEntry;
    if (storePath) {
      const persistence = await persistSessionDirectiveSnapshot({
        storePath,
        sessionKey,
        initialEntry: initialSessionEntry,
        sessionEntry,
        sessionStore,
        hasModelSelection: Boolean(modelSelection),
        reassertLiveModelSwitchPending:
          modelSelectionUpdated && sessionEntry.liveModelSwitchPending === true,
        touchedFields: touchedSessionFields,
        commitGuard: modelResolution.modelSelectionSource,
        validateCommit: preparedModel?.validateRuntimeSelection,
      });
      if (persistence.status !== "applied") {
        const errorText =
          persistence.status === "commit-rejected"
            ? persistence.error
            : persistence.status === "model-selection-locked"
              ? MODEL_SELECTION_LOCKED_MESSAGE
              : modelSelection
                ? "Model change was not applied because the session changed. Retry."
                : "Session settings were not applied because the session changed. Retry.";
        return rejectModelTransaction(errorText);
      }
    }
    if (
      modelSelection &&
      params.canPersistStickyModelSelection === true &&
      params.stickyModelSelectionTarget
    ) {
      const modelError = modelResolution.validateModelSelection?.();
      if (modelError) {
        return rejectModelTransaction(modelError);
      }
      configuredDefaultUpdate = persistStickyModelSelectionBestEffort({
        agentId: activeAgentId,
        model: `${modelSelection.provider}/${modelSelection.model}`,
        target: params.stickyModelSelectionTarget,
      });
    }
    // List projections must observe committed settings, not only model selections.
    const sessionSettingsUpdated = directiveFieldsUpdated || shouldRemapUnsupportedThinkLevel;
    if (sessionKey && (sessionSettingsUpdated || modelSelectionUpdated)) {
      emitSessionLifecycleEvent({
        sessionKey,
        agentId: activeAgentId,
        reason: "patch",
        ...(modelSelectionUpdated ? { catalogChanged: true } : {}),
      });
    }
    if (modelSelection && modelSelectionUpdated && sessionKey) {
      triggerSessionPatchHook({
        cfg: params.cfg,
        sessionEntry,
        sessionKey,
        patch: {
          key: sessionKey,
          model:
            directives.rawModelDirective ?? `${modelSelection.provider}/${modelSelection.model}`,
        },
      });
      // `/model` should retarget queued/future work without interrupting the
      // active run. Refresh queued followups so they pick up the persisted
      // selection once the current turn finishes.
      refreshQueuedFollowupSession({
        key: sessionKey,
        nextProvider: modelSelection.provider,
        nextModel: modelSelection.model,
        nextRouteResolution: "resolved",
        nextModelOverrideSource: modelSelection.isDefault ? undefined : "user",
        nextAuthProfileId: sessionEntry.authProfileOverride,
        nextAuthProfileIdSource: resolveCollapsedSessionAuthPinSource(sessionEntry),
        nextThinking: {
          level: sessionEntry.thinkingLevel,
          catalog: thinkingCatalog,
          agentRuntime: resolveThinkingRuntime(sessionEntry),
        },
      });
    }
  }
  if (modelSelection) {
    const nextLabel = `${modelSelection.provider}/${modelSelection.model}`;
    if (nextLabel !== params.initialModelLabel) {
      enqueueSystemEvent(formatModelSwitchEvent(nextLabel, modelSelection.alias), {
        sessionKey: resolveSystemEventQueueKey(sessionKey, activeAgentId),
        contextKey: `model:${nextLabel}`,
      });
    }
  }
  if (!params.persistenceState) {
    const eventSessionKey = resolveSystemEventQueueKey(sessionKey, activeAgentId);
    for (const [changed, mode, format] of [
      [elevatedChanged, "elevated", () => formatElevatedEvent(sessionEntry.elevatedLevel)],
      [reasoningChanged, "reasoning", () => formatReasoningEvent(sessionEntry.reasoningLevel)],
    ] as const) {
      if (changed) {
        enqueueSystemEvent(format(), { sessionKey: eventSessionKey, contextKey: `mode:${mode}` });
      }
    }
  }
  if (params.persistenceState) {
    params.persistenceState.outcome = {
      kind: "applied",
      provider: resolvedProvider,
      model: resolvedModel,
      modelCatalog: thinkingCatalog,
    };
  }

  const parts: string[] = [];
  const addSystemAck = (message: string) => parts.push(prefixSystemMessage(message));
  if (directives.clearThinkLevel) {
    parts.push("Thinking level reset to default.");
  } else if (directives.hasThinkDirective && directives.thinkLevel) {
    parts.push(
      directives.thinkLevel === "off"
        ? "Thinking disabled."
        : `Thinking level set to ${directives.thinkLevel}.`,
    );
  }
  if (directives.clearFastMode) {
    addSystemAck("Fast mode reset to default.");
  } else if (directives.hasFastDirective && directives.fastMode !== undefined) {
    addSystemAck(formatFastModeConfirmation(directives.fastMode));
  }
  if (directives.hasVerboseDirective && directives.verboseLevel) {
    const message = allowPrivilegedPersistence
      ? DIRECTIVE_ACK_MESSAGES.verbose[directives.verboseLevel]
      : "Verbose logging set for the current reply only.";
    addSystemAck(message);
  }
  if (directives.hasTraceDirective && directives.traceLevel) {
    addSystemAck(DIRECTIVE_ACK_MESSAGES.trace[directives.traceLevel]);
  }
  if (directives.hasVerboseDirective && directives.verboseLevel && !allowPrivilegedPersistence) {
    addSystemAck(
      "Verbose defaults require operator.admin for gateway callers; skipped persistence.",
    );
  }
  if (directives.hasReasoningDirective && directives.reasoningLevel) {
    addSystemAck(DIRECTIVE_ACK_MESSAGES.reasoning[directives.reasoningLevel]);
  }
  if (directives.hasElevatedDirective && directives.elevatedLevel) {
    addSystemAck(DIRECTIVE_ACK_MESSAGES.elevated[directives.elevatedLevel]);
    if (shouldHintDirectRuntime) {
      parts.push(ELEVATED_RUNTIME_HINT);
    }
  }
  if (directives.hasExecDirective && directives.hasExecOptions) {
    for (const [label, options] of [
      [
        allowPrivilegedPersistence && "Exec defaults set",
        { host: directives.execHost, node: directives.execNode },
      ],
      [
        "Exec policy for this run only",
        { security: directives.execSecurity, ask: directives.execAsk },
      ],
    ] as const) {
      const execParts = Object.entries(options)
        .filter(([, value]) => Boolean(value))
        .map(([key, value]) => `${key}=${value}`);
      if (execParts.length > 0) {
        const message = label
          ? `${label} (${execParts.join(", ")}).`
          : "Exec defaults require operator.admin for gateway callers; skipped persistence.";
        addSystemAck(message);
      }
    }
  }
  if (modelSelection) {
    parts.push(
      formatModelSelectionScopeAck({
        selection: modelSelection,
        configuredDefaultUpdate,
        ...(params.stickyModelSelectionTarget
          ? { stickyModelSelectionTarget: params.stickyModelSelectionTarget }
          : {}),
      }),
    );
    if (profileOverride) {
      parts.push(`Auth profile set to ${profileOverride}.`);
    }
    if (modelRuntimeResolution.kind === "clear") {
      parts.push("Runtime reset to configured policy.");
    } else if (modelRuntimeResolution.kind === "set") {
      parts.push(`Runtime set to ${modelRuntimeResolution.runtime} for this session.`);
    }
  }
  // Report the model change before the thinking remap it triggered: the remap is a
  // consequence of the model switch, so the cause should be announced first.
  if (shouldRemapUnsupportedThinkLevel && remappedUnsupportedThinkLevel) {
    parts.push(
      `Thinking level set to ${remappedUnsupportedThinkLevel} (${nextThinkLevel} not supported for ${resolvedProvider}/${resolvedModel}).`,
    );
  }
  if (directives.hasQueueDirective && directives.queueMode) {
    addSystemAck(`Queue mode set to ${directives.queueMode}.`);
  } else if (directives.hasQueueDirective && directives.queueReset) {
    addSystemAck("Queue mode reset to default.");
  }
  if (directives.hasQueueDirective && typeof directives.debounceMs === "number") {
    addSystemAck(`Queue debounce set to ${directives.debounceMs}ms.`);
  }
  if (directives.hasQueueDirective && typeof directives.cap === "number") {
    addSystemAck(`Queue cap set to ${directives.cap}.`);
  }
  if (directives.hasQueueDirective && directives.dropPolicy) {
    addSystemAck(`Queue drop set to ${directives.dropPolicy}.`);
  }
  if (fastModeChanged && !params.persistenceState) {
    const nextFastMode = directives.clearFastMode ? fastModeState.mode : sessionEntry.fastMode;
    enqueueSystemEvent(formatFastModeConfirmation(nextFastMode), {
      sessionKey: resolveSystemEventQueueKey(sessionKey, activeAgentId),
      contextKey: `fast:${formatFastModeValue(nextFastMode)}`,
    });
  }
  const ack = parts.join(" ").trim();
  return !ack && directives.hasStatusDirective ? undefined : { text: ack || "OK." };
}
