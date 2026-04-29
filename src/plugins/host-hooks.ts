import type { OperatorScope } from "../gateway/operator-scopes.js";
import type { AgentEventPayload, AgentEventStream } from "../infra/agent-events.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "./hook-types.js";
import type { PluginJsonValue } from "./host-hook-json.js";
import type {
  PluginAgentTurnPrepareResult,
  PluginNextTurnInjectionPlacement,
  PluginNextTurnInjectionRecord,
} from "./host-hook-turn-types.js";

export { isPluginJsonValue } from "./host-hook-json.js";
export type { PluginJsonPrimitive, PluginJsonValue } from "./host-hook-json.js";
export type {
  PluginAgentTurnPrepareEvent,
  PluginAgentTurnPrepareResult,
  PluginHeartbeatPromptContributionEvent,
  PluginHeartbeatPromptContributionResult,
  PluginNextTurnInjection,
  PluginNextTurnInjectionEnqueueResult,
  PluginNextTurnInjectionPlacement,
  PluginNextTurnInjectionRecord,
} from "./host-hook-turn-types.js";

export type PluginHostCleanupReason = "disable" | "reset" | "delete" | "restart";

export type PluginSessionExtensionProjectionContext = {
  sessionKey: string;
  sessionId?: string;
  state: PluginJsonValue | undefined;
};

export type PluginSessionExtensionRegistration = {
  namespace: string;
  description: string;
  project?: (ctx: PluginSessionExtensionProjectionContext) => PluginJsonValue | undefined;
  cleanup?: (ctx: { reason: PluginHostCleanupReason; sessionKey?: string }) => void | Promise<void>;
  /**
   * When set, after every successful `patchSessionExtension` the projected
   * value is mirrored to `SessionEntry[<slotKey>]` so non-plugin readers
   * (channel renderers, sidebar telemetry, etc.) can consume the typed slot
   * without reaching into `pluginExtensions[pluginId][namespace]`.
   *
   * The slot is a READ-ONLY mirror — writes always go through
   * `patchSessionExtension`; the host overwrites the slot value on every
   * subsequent patch.
   */
  sessionEntrySlotKey?: string;
  /**
   * Optional JSON-compatible schema describing the projected slot value.
   * Purely informational at this layer; clients may use it to validate the
   * mirrored slot against a contract.
   */
  sessionEntrySlotSchema?: PluginJsonValue;
};

export type PluginSessionExtensionProjection = {
  pluginId: string;
  namespace: string;
  value: PluginJsonValue;
};

export type PluginSessionExtensionPatchParams = {
  key: string;
  pluginId: string;
  namespace: string;
  value?: PluginJsonValue;
  unset?: boolean;
};

export type PluginToolPolicyDecision =
  | PluginHookBeforeToolCallResult
  | {
      allow?: boolean;
      reason?: string;
    };

export type PluginTrustedToolPolicyRegistration = {
  id: string;
  description: string;
  evaluate: (
    event: PluginHookBeforeToolCallEvent,
    ctx: PluginHookToolContext,
  ) => PluginToolPolicyDecision | void | Promise<PluginToolPolicyDecision | void>;
};

export type PluginToolMetadataRegistration = {
  toolName: string;
  displayName?: string;
  description?: string;
  risk?: "low" | "medium" | "high";
  tags?: string[];
};

export type PluginCommandContinuation = {
  continueAgent?: boolean;
};

/**
 * Declarative hint that the host's default chat input should be suppressed
 * while a plugin-owned control UI (e.g. an approval card) is mounted.
 *
 * The host does NOT enforce input suppression — UI clients consume this
 * descriptor and decide whether to hide their own input. The shape is
 * deliberately additive so client surfaces that do not understand the field
 * keep behaving as before.
 */
export type PluginControlUiSuppressHostInputWhile = {
  /** Plugin-owned state namespace whose projection drives the suppression check. */
  stateNamespace: string;
  /** Optional dot-path inside the projection to a boolean-ish flag. */
  predicateField?: string;
  /**
   * When true, suppression only applies to the session whose key matches the
   * descriptor's active session — protects against cross-session leakage.
   */
  equalsSessionKey?: boolean;
  /** When set, suppression only applies if this action id is wired by the plugin. */
  requireHandlerActionId?: string;
};

export type PluginControlUiDescriptor = {
  id: string;
  surface: "session" | "tool" | "run" | "settings";
  label: string;
  description?: string;
  placement?: string;
  renderer?: "approval-card" | "mode-switcher" | "sidebar-panel" | "input-guard" | (string & {});
  stateNamespace?: string;
  actionIds?: string[];
  schema?: PluginJsonValue;
  requiredScopes?: OperatorScope[];
  /**
   * Declarative hint to UI clients that the host's default chat input should
   * be hidden while this descriptor is active. UI clients decide whether to
   * honour the hint; the host does not enforce input gating server-side.
   */
  suppressHostInputWhile?: PluginControlUiSuppressHostInputWhile;
};

export type PluginSessionActionContext = {
  pluginId: string;
  actionId: string;
  sessionKey?: string;
  payload?: PluginJsonValue;
  client?: {
    connId?: string;
    scopes: string[];
  };
};

export type PluginSessionActionResult =
  | {
      ok?: true;
      data?: PluginJsonValue;
      reply?: PluginJsonValue;
      continueAgent?: boolean;
    }
  | {
      ok: false;
      error: string;
      code?: string;
      details?: PluginJsonValue;
    };

export type PluginSessionActionRegistration = {
  id: string;
  description?: string;
  schema?: PluginJsonValue;
  requiredScopes?: OperatorScope[];
  handler: (
    ctx: PluginSessionActionContext,
  ) => PluginSessionActionResult | void | Promise<PluginSessionActionResult | void>;
};

export type PluginRuntimeLifecycleRegistration = {
  id: string;
  description?: string;
  cleanup?: (ctx: {
    reason: PluginHostCleanupReason;
    sessionKey?: string;
    runId?: string;
  }) => void | Promise<void>;
};

export type PluginAgentEventSubscriptionRegistration = {
  id: string;
  description?: string;
  streams?: AgentEventStream[];
  handle: (
    event: AgentEventPayload,
    ctx: {
      // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Run-context JSON reads are caller-typed by namespace.
      getRunContext: <T extends PluginJsonValue = PluginJsonValue>(
        namespace: string,
      ) => T | undefined;
      setRunContext: (namespace: string, value: PluginJsonValue) => void;
      clearRunContext: (namespace?: string) => void;
    },
  ) => void | Promise<void>;
};

export type PluginRunContextPatch = {
  runId: string;
  namespace: string;
  value?: PluginJsonValue;
  unset?: boolean;
};

export type PluginRunContextGetParams = {
  runId: string;
  namespace: string;
};

export type PluginSessionSchedulerJobRegistration = {
  id: string;
  sessionKey: string;
  kind: string;
  description?: string;
  cleanup?: (ctx: {
    reason: PluginHostCleanupReason;
    sessionKey: string;
    jobId: string;
  }) => void | Promise<void>;
};

export type PluginSessionSchedulerJobHandle = {
  id: string;
  pluginId: string;
  sessionKey: string;
  kind: string;
};

export type PluginAgentEventEmitParams = {
  runId: string;
  stream: AgentEventStream;
  data: PluginJsonValue;
  sessionKey?: string;
};

export type PluginAgentEventEmitResult =
  | { emitted: true; stream: AgentEventStream }
  | { emitted: false; reason: string };

export type PluginSessionAttachmentFile = {
  path: string;
};

/**
 * Channel-specific attachment delivery hints. Each channel only consumes the
 * keys it understands; unknown keys are silently ignored, which keeps this
 * structure forward-compatible as new channels are added.
 *
 * Hint precedence vs the legacy {@link PluginSessionAttachmentParams.captionFormat}:
 *   `channelHints.<channel>.parseMode` wins when both are set.
 */
export type PluginAttachmentChannelHints = {
  telegram?: {
    parseMode?: "HTML" | "MarkdownV2";
    disableNotification?: boolean;
    forceDocumentMime?: string;
  };
  discord?: {
    ephemeral?: boolean;
    suppressEmbeds?: boolean;
  };
  slack?: {
    unfurlLinks?: boolean;
    threadTs?: string;
  };
};

export type PluginSessionAttachmentCaptionFormat = "plain" | "html" | "markdownv2";

export type PluginSessionAttachmentParams = {
  sessionKey: string;
  files: PluginSessionAttachmentFile[];
  text?: string;
  threadId?: string;
  forceDocument?: boolean;
  maxBytes?: number;
  /**
   * Caption rendering hint. Channels map this to their native parseMode
   * (e.g. `html` -> Telegram HTML). Overridden by
   * `channelHints.<channel>.parseMode` when both are set.
   */
  captionFormat?: PluginSessionAttachmentCaptionFormat;
  /** Per-channel delivery hints. Channels only consume keys they understand. */
  channelHints?: PluginAttachmentChannelHints;
};

export type PluginSessionAttachmentResult =
  | {
      ok: true;
      channel: string;
      deliveredTo: string;
      count: number;
    }
  | { ok: false; error: string };

export type PluginSessionTurnSchedule =
  | { at: string | number | Date }
  | { delayMs: number }
  | { cron: string; tz?: string };

export type PluginSessionTurnScheduleParams = PluginSessionTurnSchedule & {
  sessionKey: string;
  message: string;
  agentId?: string;
  deleteAfterRun?: boolean;
  deliveryMode?: "none" | "announce";
  name?: string;
  /**
   * Optional grouping label for cleanup. The host auto-prefixes the tag with
   * the calling plugin id (so two plugins can use the same short tag without
   * collision) and persists the prefixed tag inside the cron job's `name` so
   * `unscheduleSessionTurnsByTag` can find it later.
   */
  tag?: string;
  /**
   * Optional JSON-compatible extras merged into the cron job payload before
   * `cron.add`. Channels and downstream consumers see these fields alongside
   * the standard `agentTurn` payload — unknown fields pass through the cron
   * normaliser untouched and are recovered on cron replay.
   */
  payloadExtras?: Record<string, PluginJsonValue>;
};

export type PluginSessionTurnUnscheduleByTagParams = {
  sessionKey: string;
  tag: string;
};

export type PluginSessionTurnUnscheduleByTagResult = {
  removed: number;
  failed: number;
};

export function normalizePluginHostHookId(value: string | undefined): string {
  return (value ?? "").trim();
}

function normalizeQueuedInjectionText(
  entry: PluginNextTurnInjectionRecord,
  placement: PluginNextTurnInjectionPlacement,
): string | undefined {
  const candidate = entry as {
    placement?: unknown;
    text?: unknown;
  };
  if (candidate.placement !== placement || typeof candidate.text !== "string") {
    return undefined;
  }
  const text = candidate.text.trim();
  return text || undefined;
}

export function buildPluginAgentTurnPrepareContext(params: {
  queuedInjections: PluginNextTurnInjectionRecord[];
}): PluginAgentTurnPrepareResult {
  const prepend = params.queuedInjections
    .map((entry) => normalizeQueuedInjectionText(entry, "prepend_context"))
    .filter(Boolean);
  const append = params.queuedInjections
    .map((entry) => normalizeQueuedInjectionText(entry, "append_context"))
    .filter(Boolean);
  return {
    ...(prepend.length > 0 ? { prependContext: prepend.join("\n\n") } : {}),
    ...(append.length > 0 ? { appendContext: append.join("\n\n") } : {}),
  };
}

export type PluginHostHookRunContext = PluginHookAgentContext;
