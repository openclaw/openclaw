// Serialization shape of a persisted followup queue row.
//
// Types and the field allowlist only — no runtime behavior. Keeping them in a
// leaf module lets the codec stay within its size budget without splitting the
// projections away from the fail-closed validators that guard them.
import type { QueueMode } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { FollowupRun, QueueDropPolicy } from "./types.js";

/**
 * Minimal recovery descriptor for FollowupRun["run"]. Persisted fields are the
 * per-message routing and intent inputs that cannot be recovered any other
 * way after a restart. Bulky or secret-bearing runtime state (config,
 * skillsSnapshot, extraSystemPrompt[Static]) is intentionally excluded — the
 * dispatcher reassigns `run.config` via resolveQueuedReplyExecutionConfig on the
 * next turn. Routing selectors (authProfileId[Source], originatingReplyToId)
 * are persisted because restored turns need the same reply target they were
 * queued with. `inputProvenance` is persisted only as a closed non-authoritative
 * `{ kind, sourceChannel, sourceTool }` descriptor; `originSessionId` and
 * `sourceSessionKey` are never written and are stripped from older rows so
 * restore cannot reuse raw source-session identifiers for requester-policy.
 *
 * Session policy and prepared routing captured at admission (`toolOverrides`,
 * `conversationToolPolicy`, `requestedRouteResolution`, `thinkingCatalog`) plus
 * top-level `toolsAllow` / `disableTools` (and the non-enumerable allowlist
 * intersection carrier) are included so a restart cannot broaden tools or
 * re-resolve models away from the queued turn's intent. `permissionMode` and
 * `sessionRoot` are persisted as one closed pair so a session-scoped execution
 * restriction cannot fall back to the default policy after restart. Restore
 * rehydrates the pair together; a half-written or invalid pair fail-closes.
 * `scheduledToolPolicy` is persisted in its closed JSON shape so restored
 * cron/scheduled turns keep their restricted tool authority instead of falling
 * back to sender/group policy.
 *
 * `skillWorkshopProposalRevision` is persisted as a closed
 * `{ agentId, workspaceDir, proposalId, expectedRevisionHash }` envelope so an
 * operator-reviewed Workshop turn cannot lose its proposal/action restriction
 * or revision hash across restart. Invalid persisted constraints fail-close.
 *
 * Delegated live authority (`trustedInternalHandoff`, `runtimePluginToolGrant`)
 * is never serialized. Those queued turns are marked `delegatedAuthority` and
 * fail-closed on restore: copied fields cannot prove the originating claim is
 * still live after a Gateway restart, and draining without them would silently
 * change tool policy. The skip is logged and the SQLite row is dropped so the
 * non-delivery is durable. `terminalReplyExpectation` is persisted so a required
 * reply cannot become optional after restart. Invalid persisted values fail-close.
 *
 * `cliSessionBindingFacts` persists only delivery flags (`sourceReplyDeliveryMode`,
 * `requireExplicitMessageTarget`). Nested `extraSystemPromptStatic` is secret-bearing
 * and is never written; restore also strips it from older rows.
 *
 * Raw channel identities (`senderId`, `senderName`, `senderUsername`,
 * `senderE164`, `channelContext`) are never persisted. Those values are
 * requester-policy inputs, and without them restore cannot re-run channel
 * access policy, so turns that carry them are left out of the snapshot entirely
 * and older rows that still carry them fail closed and are removed from SQLite.
 * Delivery stays on the closed originating route (`originatingChannel` /
 * `originatingTo`). Restored identity-less entries drain individually so
 * collect cannot merge entries that share an empty authorization key.
 *
 * Sender privilege bits (`senderIsOwner`, `traceAuthorized`, `ownerNumbers`)
 * are never persisted. Restore always fences them to explicit non-owner so
 * owner-only tools cannot reopen from a stored true/undefined default.
 *
 * Exec elevation (`elevatedLevel`, `bashElevated`) and broadening overlays
 * (`security: "full"`, `ask: "off"`, `host: "gateway"|"node"`) are never
 * persisted. Restrictive `execOverrides` (`security: "deny"|"allowlist"`,
 * `ask: "always"|"on-miss"`, `host: "sandbox"`) persist as a closed projection
 * so restart cannot widen exec authority. Restore rehydrates that projection;
 * unknown keys or invalid values fail-close. `node` / `nodeCwd` are never
 * written (they retarget execution).
 *
 * Live client-bound facts (`clientCaps`, `toolBindings`, `approvalReviewerDeviceId`)
 * are never persisted. Restore strips them even from older rows so a queued
 * turn cannot target a stale browser or approval device after restart.
 *
 * Host-minted `memberRoleIds` are never serialized. Role-dependent queued work
 * is marked `roleDependent` and fail-closed on restore: channel roles cannot be
 * revalidated in this persist layer, and draining without them would silently
 * change role-gated authorization. The skip is logged and the SQLite row is
 * dropped so the non-delivery is durable.
 *
 * Use Pick (allowlist), not Omit, so new fields added to FollowupRun["run"]
 * default to NOT persisted until explicitly opted in.
 */
export type PersistedRunFields = Pick<
  FollowupRun["run"],
  | "agentId"
  | "agentDir"
  | "sessionId"
  | "sessionKey"
  | "runtimePolicySessionKey"
  | "messageProvider"
  | "chatType"
  | "agentAccountId"
  | "groupId"
  | "groupChannel"
  | "groupSpace"
  | "spawnedBy"
  | "sessionFile"
  | "workspaceDir"
  | "cwd"
  | "permissionMode"
  | "sessionRoot"
  | "execOverrides"
  | "provider"
  | "model"
  | "hasSessionModelOverride"
  | "modelOverrideSource"
  | "hasAutoFallbackProvenance"
  | "autoFallbackPrimaryProbe"
  | "modelSelectionLocked"
  | "authProfileId"
  | "authProfileIdSource"
  | "toolOverrides"
  | "conversationToolPolicy"
  | "requestedRouteResolution"
  | "thinkingCatalog"
  | "scheduledToolPolicy"
  | "skillWorkshopProposalRevision"
  | "terminalReplyExpectation"
  | "thinkLevel"
  | "fastMode"
  | "fastModeAutoOnSeconds"
  | "fastModeOverride"
  | "fastModeAutoOnSecondsOverride"
  | "verboseLevel"
  | "reasoningLevel"
  | "timeoutMs"
  | "runTimeoutOverrideMs"
  | "blockReplyBreak"
  | "inputProvenance"
  | "sourceReplyDeliveryMode"
  | "taskSuggestionDeliveryMode"
  | "silentReplyPromptMode"
  | "cliSessionBindingFacts"
  | "enforceFinalTag"
  | "skipProviderRuntimeHints"
  | "silentExpected"
  | "suppressNextUserMessagePersistence"
  | "suppressTranscriptOnlyAssistantPersistence"
>;

/**
 * Subset of FollowupRun that can be safely JSON-serialized across restarts.
 * Runtime-only fields (abortSignal, deliveryCorrelations, queuedLifecycle,
 * userTurnTranscriptRecorder, currentInboundContext) are intentionally excluded.
 * Bounded inbound flags (event kind, audio) are persisted so restored drains
 * keep routing shape; raw current-turn prompt context is never written and is
 * stripped from older rows.
 */
export type PersistedFollowupRun = Pick<
  FollowupRun,
  | "prompt"
  | "transcriptPrompt"
  | "messageId"
  | "summaryLine"
  | "enqueuedAt"
  | "imageOrder"
  | "media"
  | "currentInboundEventKind"
  | "currentInboundAudio"
  | "originatingChannel"
  | "originatingTo"
  | "originatingAccountId"
  | "originatingThreadId"
  | "originatingReplyToId"
  | "originatingChatId"
  | "originatingReplyToMode"
  | "originatingChatType"
  | "disableCollectBatching"
  | "strandedReplyRetry"
  | "toolsAllow"
  | "disableTools"
  | "explicitSkillSelections"
> & {
  run: PersistedRunFields;
  /** Serializable form of the non-enumerable allowlist intersection carrier. */
  toolsAllowIntersection?: string[][];
  /**
   * True when the live run carried host-minted member roles. Restore fail-closes
   * these items instead of executing without role context or replaying stale IDs.
   */
  roleDependent?: true;
  /**
   * True when the live run carried delegated handoff or plugin-grant authority.
   * Restore fail-closes these items instead of replaying a copied claim.
   */
  delegatedAuthority?: true;
  /**
   * True when the live run was canceled before drain settled. Restore fail-closes
   * these items because abort signals are not serialized.
   */
  canceled?: true;
  /**
   * True when channel delivery already succeeded. Restore fail-closes these
   * items so a crash before the omit-ack cannot replay the follow-up.
   */
  delivered?: true;
  /**
   * True when execution finished but terminal delivery failed. Restore
   * fail-closes these items so a crash before omit cannot replay side effects.
   */
  discarded?: true;
  /**
   * True when the live run carried inline image payloads. Raw image bytes are
   * never written to shared SQLite; restore fail-closes marked items (and
   * legacy rows still carrying `images`) instead of replaying a turn whose
   * image content was deliberately not retained.
   */
  inlineImagesElided?: true;
};

export type PersistedSummaryElision = {
  contextKey: string;
  count: number;
  sources: PersistedFollowupRun[];
  summaryLines: string[];
};

export type PersistedQueueEntry = {
  items: PersistedFollowupRun[];
  lastEnqueuedAt: number;
  mode: QueueMode;
  debounceMs: number;
  cap: number;
  dropPolicy: QueueDropPolicy;
  droppedCount: number;
  summaryLines: string[];
  summarySources?: PersistedFollowupRun[];
  summaryElisions?: PersistedSummaryElision[];
  evictedSummaryCount?: number;
  lastRun?: PersistedRunFields;
};

export const PERSISTED_RUN_FIELDS = [
  "agentId",
  "agentDir",
  "sessionId",
  "sessionKey",
  "runtimePolicySessionKey",
  "messageProvider",
  "chatType",
  "agentAccountId",
  "groupId",
  "groupChannel",
  "groupSpace",
  "spawnedBy",
  "sessionFile",
  "workspaceDir",
  "cwd",
  "permissionMode",
  "sessionRoot",
  "execOverrides",
  "provider",
  "model",
  "hasSessionModelOverride",
  "modelOverrideSource",
  "hasAutoFallbackProvenance",
  "autoFallbackPrimaryProbe",
  "modelSelectionLocked",
  "authProfileId",
  "authProfileIdSource",
  "toolOverrides",
  "conversationToolPolicy",
  "requestedRouteResolution",
  "thinkingCatalog",
  "scheduledToolPolicy",
  "skillWorkshopProposalRevision",
  "terminalReplyExpectation",
  "thinkLevel",
  "fastMode",
  "fastModeAutoOnSeconds",
  "fastModeOverride",
  "fastModeAutoOnSecondsOverride",
  "verboseLevel",
  "reasoningLevel",
  "timeoutMs",
  "runTimeoutOverrideMs",
  "blockReplyBreak",
  "inputProvenance",
  "sourceReplyDeliveryMode",
  "taskSuggestionDeliveryMode",
  "silentReplyPromptMode",
  "cliSessionBindingFacts",
  "enforceFinalTag",
  "skipProviderRuntimeHints",
  "silentExpected",
  "suppressNextUserMessagePersistence",
  "suppressTranscriptOnlyAssistantPersistence",
] as const satisfies ReadonlyArray<keyof PersistedRunFields>;
