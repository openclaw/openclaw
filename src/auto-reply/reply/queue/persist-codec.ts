import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  attachToolAllowlistIntersection,
  readToolAllowlistIntersection,
} from "../../../agents/tool-policy.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeCronScheduledToolPolicy } from "../../../cron/scheduled-tool-policy.js";
import {
  filterWorkspaceSkills,
  loadWorkspaceSkills,
} from "../../../skills/loading/workspace-skill-loader.js";
import {
  hasInvalidInputProvenance,
  hasInvalidRestrictiveExecOverrides,
  hasInvalidSessionPermissionPolicy,
  persistedFollowupItemCarriesInboundContext,
  persistedInputProvenanceCarriesSourceIdentity,
  persistedRunCarriesRawChannelIdentity,
  projectCliSessionBindingFacts,
  projectInputProvenance,
  projectRestrictiveExecOverrides,
  projectSessionPermissionPair,
} from "./persist-codec-policy.js";
import {
  PERSISTED_RUN_FIELDS,
  type PersistedFollowupRun,
  type PersistedQueueEntry,
  type PersistedRunFields,
  type PersistedSummaryElision,
} from "./persist-codec.types.js";
import type { FollowupQueueState, FollowupRun } from "./types.js";

function asWritableRecord(value: object): Record<string, unknown> {
  // SAFETY: persist copies JSON-shaped objects by closed allowlisted keys.
  return value as Record<string, unknown>;
}

function asCompletedPersistedRunFields(projected: Partial<PersistedRunFields>): PersistedRunFields {
  // SAFETY: every assigned key came from PERSISTED_RUN_FIELDS on a live FollowupRun.
  return projected as PersistedRunFields;
}

function projectRunForPersist(run: FollowupRun["run"]): PersistedRunFields {
  const projected: Partial<PersistedRunFields> = {};
  const writable = asWritableRecord(projected);
  // Project the closed pair before generic field filtering. A root-only live
  // run never visits permissionMode (value is undefined), so doing this inside
  // that iteration would drop sessionRoot and skip restore fail-closed.
  const sessionPermission = projectSessionPermissionPair(run);
  if (sessionPermission) {
    projected.permissionMode = sessionPermission.permissionMode;
    projected.sessionRoot = sessionPermission.sessionRoot;
  } else if (run.permissionMode !== undefined || run.sessionRoot !== undefined) {
    if (run.permissionMode !== undefined) {
      writable.permissionMode = run.permissionMode;
    }
    if (run.sessionRoot !== undefined) {
      writable.sessionRoot = run.sessionRoot;
    }
  }
  const restrictiveExecOverrides = projectRestrictiveExecOverrides(run.execOverrides);
  if (restrictiveExecOverrides) {
    projected.execOverrides = restrictiveExecOverrides;
  } else if (hasInvalidRestrictiveExecOverrides(run) && run.execOverrides !== undefined) {
    writable.execOverrides = run.execOverrides;
  }
  for (const key of PERSISTED_RUN_FIELDS) {
    if (key === "permissionMode" || key === "sessionRoot" || key === "execOverrides") {
      continue;
    }
    const value = run[key];
    if (value !== undefined) {
      // Field-by-field copy keeps each value in its source type without
      // forcing a single union onto the projected map's index type.
      if (key === "scheduledToolPolicy") {
        // Persist the closed envelope when valid. Keep a non-normalizable value
        // as-is so restore fail-closes instead of dropping the authority field.
        writable[key] = normalizeCronScheduledToolPolicy(value) ?? value;
        continue;
      }
      if (key === "skillWorkshopProposalRevision") {
        writable[key] = projectSkillWorkshopProposalRevision(value) ?? value;
        continue;
      }
      if (key === "terminalReplyExpectation") {
        writable[key] = projectTerminalReplyExpectation(value) ?? value;
        continue;
      }
      if (key === "inputProvenance") {
        writable[key] = projectInputProvenance(value) ?? value;
        continue;
      }
      if (key === "cliSessionBindingFacts") {
        const projectedFacts = projectCliSessionBindingFacts(run.cliSessionBindingFacts);
        if (projectedFacts) {
          projected.cliSessionBindingFacts = projectedFacts;
        }
        continue;
      }
      writable[key] = value;
    }
  }
  return asCompletedPersistedRunFields(projected);
}

export function isPersistedRunFields(value: unknown): value is PersistedRunFields {
  return (
    isRecord(value) &&
    typeof value.agentId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.sessionFile === "string" &&
    typeof value.workspaceDir === "string" &&
    typeof value.provider === "string" &&
    typeof value.model === "string" &&
    typeof value.timeoutMs === "number" &&
    (value.blockReplyBreak === "text_end" || value.blockReplyBreak === "message_end")
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isToolsAllowIntersection(value: unknown): value is string[][] {
  return Array.isArray(value) && value.every(isStringArray);
}

function parseToolsAllowIntersection(value: unknown): string[][] | undefined {
  return isToolsAllowIntersection(value) ? value.map((group) => group.slice()) : undefined;
}

function isPersistedFollowupRun(value: unknown): value is PersistedFollowupRun {
  return (
    isRecord(value) &&
    typeof value.prompt === "string" &&
    typeof value.enqueuedAt === "number" &&
    isPersistedRunFields(value.run) &&
    (value.toolsAllow === undefined || isStringArray(value.toolsAllow)) &&
    (value.disableTools === undefined || typeof value.disableTools === "boolean") &&
    (value.toolsAllowIntersection === undefined ||
      isToolsAllowIntersection(value.toolsAllowIntersection)) &&
    (value.roleDependent === undefined || value.roleDependent === true) &&
    (value.delegatedAuthority === undefined || value.delegatedAuthority === true) &&
    (value.canceled === undefined || value.canceled === true) &&
    (value.delivered === undefined || value.delivered === true) &&
    (value.discarded === undefined || value.discarded === true) &&
    (value.explicitSkillSelections === undefined || Array.isArray(value.explicitSkillSelections))
  );
}

function isPersistedSummaryElision(value: unknown): value is PersistedSummaryElision {
  return (
    isRecord(value) &&
    typeof value.contextKey === "string" &&
    typeof value.count === "number" &&
    Array.isArray(value.sources) &&
    value.sources.every(isPersistedFollowupRun) &&
    Array.isArray(value.summaryLines) &&
    value.summaryLines.every((line) => typeof line === "string")
  );
}

export function isPersistedQueueEntry(value: unknown): value is PersistedQueueEntry {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    !value.items.every(isPersistedFollowupRun)
  ) {
    return false;
  }
  if (
    value.summarySources !== undefined &&
    (!Array.isArray(value.summarySources) || !value.summarySources.every(isPersistedFollowupRun))
  ) {
    return false;
  }
  if (
    value.summaryElisions !== undefined &&
    (!Array.isArray(value.summaryElisions) ||
      !value.summaryElisions.every(isPersistedSummaryElision))
  ) {
    return false;
  }
  if (value.evictedSummaryCount !== undefined && typeof value.evictedSummaryCount !== "number") {
    return false;
  }
  return true;
}

/**
 * Drop restored items that cannot be safely reassociated with a session/route.
 * Keeps process-local and incomplete descriptors from hijacking the wrong delivery.
 */
function hasLegacyMemberRoleIds(run: PersistedRunFields): boolean {
  const ids = asWritableRecord(run).memberRoleIds;
  return Array.isArray(ids) && ids.length > 0;
}

export function isRoleDependentPersistedFollowup(item: PersistedFollowupRun): boolean {
  return item.roleDependent === true || hasLegacyMemberRoleIds(item.run);
}

function hasLegacyDelegatedAuthority(run: PersistedRunFields): boolean {
  const record = asWritableRecord(run);
  return record.trustedInternalHandoff !== undefined || record.runtimePluginToolGrant !== undefined;
}

export function isDelegatedAuthorityPersistedFollowup(item: PersistedFollowupRun): boolean {
  return item.delegatedAuthority === true || hasLegacyDelegatedAuthority(item.run);
}

export function isCanceledPersistedFollowup(item: PersistedFollowupRun): boolean {
  return item.canceled === true;
}

export function isDeliveredPersistedFollowup(item: PersistedFollowupRun): boolean {
  return item.delivered === true;
}

export function isDiscardedPersistedFollowup(item: PersistedFollowupRun): boolean {
  return item.discarded === true;
}

export function describeFollowupForLog(item: PersistedFollowupRun): string {
  const parts: string[] = [];
  if (typeof item.messageId === "string" && item.messageId.length > 0) {
    parts.push(`messageId=${item.messageId}`);
  }
  if (typeof item.originatingChannel === "string" && item.originatingChannel.length > 0) {
    parts.push(`channel=${item.originatingChannel}`);
  }
  return parts.length > 0 ? parts.join(" ") : "no-route-metadata";
}

const MAX_EXPLICIT_SKILL_SELECTIONS = 32;
const MAX_EXPLICIT_SKILL_NAME_LENGTH = 128;
const MAX_EXPLICIT_SKILL_PATH_LENGTH = 1024;

export type RestoredExplicitSkillSelections = NonNullable<FollowupRun["explicitSkillSelections"]>;
export type ExplicitSkillRestoreResolution =
  | { status: "absent" }
  | { status: "ok"; selections: RestoredExplicitSkillSelections }
  | { status: "invalid" };

function comparableSkillPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function projectExplicitSkillSelections(
  value: unknown,
): RestoredExplicitSkillSelections | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EXPLICIT_SKILL_SELECTIONS) {
    return undefined;
  }
  const projected: RestoredExplicitSkillSelections = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      return undefined;
    }
    const name = normalizeOptionalString(entry.name);
    const skillPath = normalizeOptionalString(entry.path);
    if (
      !name ||
      !skillPath ||
      name.length > MAX_EXPLICIT_SKILL_NAME_LENGTH ||
      skillPath.length > MAX_EXPLICIT_SKILL_PATH_LENGTH
    ) {
      return undefined;
    }
    projected.push({ name, path: skillPath });
  }
  return projected;
}

export function createExplicitSkillRestoreResolver(
  currentConfig: OpenClawConfig,
): (item: PersistedFollowupRun) => ExplicitSkillRestoreResolution {
  const catalogs = new Map<string, Array<{ name: string; path: string }> | null>();
  const loadCatalog = (workspaceDir: string, agentId: string | undefined) => {
    const key = `${workspaceDir}\0${agentId ?? ""}`;
    if (catalogs.has(key)) {
      return catalogs.get(key) ?? null;
    }
    try {
      // Restore runs synchronously during module evaluation, so it reads the
      // synchronous inventory. The explicit filter pass keeps config-disabled
      // skills out even when no agent skill filter applies.
      const eligible = filterWorkspaceSkills(
        loadWorkspaceSkills(workspaceDir, { config: currentConfig, agentId }),
        { config: currentConfig },
      ).map((entry) => ({
        name: entry.skill.name,
        path: entry.skill.filePath,
      }));
      catalogs.set(key, eligible);
      return eligible;
    } catch {
      catalogs.set(key, null);
      return null;
    }
  };

  return (item: PersistedFollowupRun): ExplicitSkillRestoreResolution => {
    if (item.explicitSkillSelections === undefined) {
      return { status: "absent" };
    }
    const projected = projectExplicitSkillSelections(item.explicitSkillSelections);
    if (!projected) {
      return { status: "invalid" };
    }
    const workspaceDir = normalizeOptionalString(item.run.workspaceDir);
    if (!workspaceDir) {
      return { status: "invalid" };
    }
    const catalog = loadCatalog(workspaceDir, normalizeOptionalString(item.run.agentId));
    if (!catalog) {
      return { status: "invalid" };
    }
    const resolved: RestoredExplicitSkillSelections = [];
    for (const selection of projected) {
      const selectedPath = comparableSkillPath(selection.path);
      const skill = catalog.find(
        (candidate) => comparableSkillPath(candidate.path) === selectedPath,
      );
      if (!skill) {
        return { status: "invalid" };
      }
      resolved.push({ name: skill.name, path: skill.path });
    }
    return { status: "ok", selections: resolved };
  };
}

export function hasInvalidExplicitSkillSelections(
  item: PersistedFollowupRun,
  resolveExplicitSkillSelections: (item: PersistedFollowupRun) => ExplicitSkillRestoreResolution,
): boolean {
  return resolveExplicitSkillSelections(item).status === "invalid";
}

export function hasInvalidScheduledToolPolicy(run: PersistedRunFields): boolean {
  return (
    run.scheduledToolPolicy !== undefined &&
    normalizeCronScheduledToolPolicy(run.scheduledToolPolicy) === undefined
  );
}

export {
  hasInvalidInputProvenance,
  hasInvalidRestrictiveExecOverrides,
  hasInvalidSessionPermissionPolicy,
  persistedFollowupItemCarriesInboundContext,
  persistedInputProvenanceCarriesSourceIdentity,
  persistedRunCarriesRawChannelIdentity,
};

const SKILL_WORKSHOP_REVISION_HASH = /^[0-9a-f]{64}$/i;

function projectSkillWorkshopProposalRevision(
  value: unknown,
): FollowupRun["run"]["skillWorkshopProposalRevision"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const agentId = normalizeOptionalString(value.agentId);
  const workspaceDir = normalizeOptionalString(value.workspaceDir);
  const proposalId = normalizeOptionalString(value.proposalId);
  const expectedRevisionHash = normalizeOptionalString(value.expectedRevisionHash);
  if (!agentId || !workspaceDir || !proposalId || !expectedRevisionHash) {
    return undefined;
  }
  if (!SKILL_WORKSHOP_REVISION_HASH.test(expectedRevisionHash)) {
    return undefined;
  }
  return { agentId, workspaceDir, proposalId, expectedRevisionHash };
}

export function hasInvalidSkillWorkshopProposalRevision(run: PersistedRunFields): boolean {
  return (
    run.skillWorkshopProposalRevision !== undefined &&
    projectSkillWorkshopProposalRevision(run.skillWorkshopProposalRevision) === undefined
  );
}

function projectTerminalReplyExpectation(
  value: unknown,
): FollowupRun["run"]["terminalReplyExpectation"] | undefined {
  return value === "required" || value === "optional" ? value : undefined;
}

export function hasInvalidTerminalReplyExpectation(run: PersistedRunFields): boolean {
  return (
    run.terminalReplyExpectation !== undefined &&
    projectTerminalReplyExpectation(run.terminalReplyExpectation) === undefined
  );
}

export function hasInvalidToolsAllowIntersection(item: PersistedFollowupRun): boolean {
  return item.toolsAllowIntersection !== undefined && item.toolsAllow === undefined;
}

const LEGACY_PERSISTED_RUN_OVERLAYS = [
  "memberRoleIds",
  "elevatedLevel",
  "bashElevated",
  "clientCaps",
  "toolBindings",
  "approvalReviewerDeviceId",
  "trustedInternalHandoff",
  "runtimePluginToolGrant",
  "senderId",
  "senderName",
  "senderUsername",
  "senderE164",
  "channelContext",
] as const;

/** Closed envelopes are re-projected; raw values must not leak through `...rest`. */
const CLOSED_PERSISTED_RUN_FIELDS = [
  "permissionMode",
  "sessionRoot",
  "execOverrides",
  "scheduledToolPolicy",
  "skillWorkshopProposalRevision",
  "terminalReplyExpectation",
  "inputProvenance",
  "cliSessionBindingFacts",
] as const;

export function rehydrateRun(
  run: PersistedRunFields,
  currentConfig: OpenClawConfig,
): FollowupRun["run"] {
  const rest: PersistedRunFields = { ...run };
  const overlays = asWritableRecord(rest);
  for (const key of LEGACY_PERSISTED_RUN_OVERLAYS) {
    delete overlays[key];
  }
  const sessionPermission = projectSessionPermissionPair(rest);
  const execOverrides = projectRestrictiveExecOverrides(rest.execOverrides);
  const scheduledToolPolicy = normalizeCronScheduledToolPolicy(rest.scheduledToolPolicy);
  const skillWorkshopProposalRevision = projectSkillWorkshopProposalRevision(
    rest.skillWorkshopProposalRevision,
  );
  const terminalReplyExpectation = projectTerminalReplyExpectation(rest.terminalReplyExpectation);
  const inputProvenance = projectInputProvenance(rest.inputProvenance);
  const cliSessionBindingFacts = projectCliSessionBindingFacts(rest.cliSessionBindingFacts);
  for (const key of CLOSED_PERSISTED_RUN_FIELDS) {
    delete overlays[key];
  }
  return {
    ...rest,
    config: currentConfig,
    // Owner-only conversation tools deny only explicit false. Fence privilege
    // bits even if an older SQLite row still serialized them.
    senderIsOwner: false,
    traceAuthorized: false,
    ownerNumbers: [],
    ...(sessionPermission
      ? {
          permissionMode: sessionPermission.permissionMode,
          sessionRoot: sessionPermission.sessionRoot,
        }
      : {}),
    ...(execOverrides ? { execOverrides } : {}),
    ...(scheduledToolPolicy ? { scheduledToolPolicy } : {}),
    ...(skillWorkshopProposalRevision ? { skillWorkshopProposalRevision } : {}),
    ...(terminalReplyExpectation ? { terminalReplyExpectation } : {}),
    ...(inputProvenance ? { inputProvenance } : {}),
    ...(cliSessionBindingFacts
      ? { cliSessionBindingFacts }
      : { cliSessionBindingFacts: undefined }),
  };
}
function toPersistedRun(item: FollowupRun): PersistedFollowupRun {
  const toolsAllowIntersection = item.toolsAllow
    ? readToolAllowlistIntersection(item.toolsAllow)
    : undefined;
  const explicitSkillSelections = projectExplicitSkillSelections(item.explicitSkillSelections);
  const carriesInlineImages = (item.images?.length ?? 0) > 0;
  return {
    prompt: item.prompt,
    ...(item.transcriptPrompt !== undefined ? { transcriptPrompt: item.transcriptPrompt } : {}),
    ...(item.messageId !== undefined ? { messageId: item.messageId } : {}),
    ...(item.summaryLine !== undefined ? { summaryLine: item.summaryLine } : {}),
    enqueuedAt: item.enqueuedAt,
    // Inline image bytes never reach shared SQLite; the marker fail-closes on
    // restore instead of retaining payload content across restarts.
    ...(carriesInlineImages ? { inlineImagesElided: true as const } : {}),
    ...(!carriesInlineImages && item.imageOrder !== undefined
      ? { imageOrder: item.imageOrder }
      : {}),
    ...(item.media !== undefined ? { media: item.media } : {}),
    ...(item.currentInboundEventKind !== undefined
      ? { currentInboundEventKind: item.currentInboundEventKind }
      : {}),
    ...(item.currentInboundAudio === true ? { currentInboundAudio: true } : {}),
    ...(item.originatingChannel !== undefined
      ? { originatingChannel: item.originatingChannel }
      : {}),
    ...(item.originatingTo !== undefined ? { originatingTo: item.originatingTo } : {}),
    ...(item.originatingAccountId !== undefined
      ? { originatingAccountId: item.originatingAccountId }
      : {}),
    ...(item.originatingThreadId !== undefined
      ? { originatingThreadId: item.originatingThreadId }
      : {}),
    ...(item.originatingReplyToId !== undefined
      ? { originatingReplyToId: item.originatingReplyToId }
      : {}),
    ...(item.originatingChatId !== undefined ? { originatingChatId: item.originatingChatId } : {}),
    ...(item.originatingReplyToMode !== undefined
      ? { originatingReplyToMode: item.originatingReplyToMode }
      : {}),
    ...(item.originatingChatType !== undefined
      ? { originatingChatType: item.originatingChatType }
      : {}),
    ...(item.disableCollectBatching === true ? { disableCollectBatching: true } : {}),
    ...(item.strandedReplyRetry === true ? { strandedReplyRetry: true } : {}),
    ...(item.toolsAllow !== undefined ? { toolsAllow: [...item.toolsAllow] } : {}),
    ...(item.disableTools === true ? { disableTools: true } : {}),
    ...(explicitSkillSelections ? { explicitSkillSelections } : {}),
    ...(toolsAllowIntersection
      ? { toolsAllowIntersection: toolsAllowIntersection.map((group) => group.slice()) }
      : {}),
    ...(Array.isArray(item.run.memberRoleIds) && item.run.memberRoleIds.length > 0
      ? { roleDependent: true as const }
      : {}),
    ...(item.run.trustedInternalHandoff !== undefined ||
    item.run.runtimePluginToolGrant !== undefined
      ? { delegatedAuthority: true as const }
      : {}),
    ...(item.canceled === true ? { canceled: true as const } : {}),
    ...(item.delivered === true ? { delivered: true as const } : {}),
    ...(item.discarded === true ? { discarded: true as const } : {}),
    run: projectRunForPersist(item.run),
  };
}

/**
 * Work already held by a canonical durable owner.
 *
 * - `stageApproved` writes a pending-input receipt before acknowledgement, and
 *   that owner runs its own restart recovery with fresh-admission checks.
 * - Durable channel ingress admits turns with an `exclusive` adoption lifecycle
 *   and holds its claim until adoption, so its restart recovery replays the
 *   event through channel admission again.
 *
 * A second runnable copy here would replay accepted input outside those owners
 * while the original receipt or ingress claim stayed claimable, so the turn
 * could execute twice. This queue persists only work neither owner covers.
 */
function isCanonicallyOwnedFollowup(item: FollowupRun): boolean {
  return (
    item.userTurnTranscriptRecorder?.getPendingInputMessage?.() !== undefined ||
    item.turnAdoptionLifecycle?.admission === "exclusive"
  );
}

/**
 * Work whose admission depended on the channel sender.
 *
 * Sender identity is never persisted, so a restored turn could not re-run the
 * channel's access policy before reaching the model, tools, or the channel. A
 * sender removed from that policy while the turn waited would still be served.
 * These turns are not written at all rather than written only to fail closed.
 */
function isSenderBoundFollowup(item: FollowupRun): boolean {
  return persistedRunCarriesRawChannelIdentity(item.run);
}

/**
 * Work whose admission retained a live operator capability.
 *
 * `operatorAuthority` is a live handle: `assertCurrent()` is what re-checks a
 * revoked device or a reassigned operator role before the turn reaches the
 * model, tools, or the channel. It cannot be serialized, and a restored turn
 * would carry `undefined`, making every one of those checks a silent no-op.
 * Persisting the turn without it would resume operator-bound work with its
 * authorization owner stripped, so these turns are not written at all — the
 * same treatment sender-bound work gets, for the same reason.
 */
function isOperatorAuthorityBoundFollowup(item: FollowupRun): boolean {
  return item.operatorAuthority !== undefined;
}

/**
 * Whether this owner will refuse to write `item` at all.
 *
 * Enqueue consults this so a shared-SQLite outage cannot reject work that only
 * ever lives in memory: there is no row to lose, so there is nothing to fail.
 */
export function isOutsideDurableQueueCustody(item: FollowupRun): boolean {
  return (
    isCanonicallyOwnedFollowup(item) ||
    isSenderBoundFollowup(item) ||
    isOperatorAuthorityBoundFollowup(item)
  );
}

/**
 * Drop sources outside durable custody while keeping each retained source paired with its
 * summary line. Restore rejects the whole group when the two lengths disagree,
 * so the filter has to move both arrays together.
 */
function retainPersistableSummarySources(
  sources: readonly FollowupRun[],
  lines: readonly string[],
): { sources: FollowupRun[]; lines: string[] } {
  if (lines.length !== sources.length) {
    // Unpaired input is already outside the restore contract; leave it for the
    // existing fail-closed path rather than inventing an alignment here.
    return {
      sources: sources.filter((source) => !isOutsideDurableQueueCustody(source)),
      lines: [...lines],
    };
  }
  const retainedSources: FollowupRun[] = [];
  const retainedLines: string[] = [];
  for (const [index, source] of sources.entries()) {
    if (isOutsideDurableQueueCustody(source)) {
      continue;
    }
    retainedSources.push(source);
    retainedLines.push(lines[index]!);
  }
  return { sources: retainedSources, lines: retainedLines };
}

/**
 * Overflow sources dropped by custody filtering must also leave `droppedCount`.
 *
 * `droppedCount` is what drain uses to decide the queue still owes a summary
 * delivery. Retaining the count for a source this snapshot refuses to write
 * leaves a restored queue permanently short: it delivers the sources it has,
 * the count never reaches zero, and the empty queue reschedules forever.
 */
function countDroppedSourcesOutsideCustody(queue: FollowupQueueState): number {
  const summaryDropped = queue.summarySources.filter((source) =>
    isOutsideDurableQueueCustody(source),
  ).length;
  const elisionDropped = queue.summaryElisions.reduce(
    (total, entry) =>
      total + entry.sources.filter((source) => isOutsideDurableQueueCustody(source)).length,
    0,
  );
  return summaryDropped + elisionDropped;
}

export function toPersistedQueueEntry(queue: FollowupQueueState): PersistedQueueEntry {
  const summarizedSources = new Set([
    ...queue.summarySources,
    ...queue.summaryElisions.flatMap((entry) => entry.sources),
  ]);
  const items = [
    ...queue.items,
    ...[...queue.inFlight].filter(
      (source) => !queue.items.includes(source) && !summarizedSources.has(source),
    ),
  ].filter((item) => !isOutsideDurableQueueCustody(item));
  const summary = retainPersistableSummarySources(queue.summarySources, queue.summaryLines);
  return {
    // Keep in-flight identities in SQLite until channel delivery succeeds (or
    // fail-closed discard). Memory inFlight is overflow protection only.
    items: items.map(toPersistedRun),
    lastEnqueuedAt: queue.lastEnqueuedAt,
    mode: queue.mode,
    debounceMs: queue.debounceMs,
    cap: queue.cap,
    dropPolicy: queue.dropPolicy,
    droppedCount: Math.max(0, queue.droppedCount - countDroppedSourcesOutsideCustody(queue)),
    summaryLines: summary.lines,
    summarySources: summary.sources.map(toPersistedRun),
    summaryElisions: queue.summaryElisions.flatMap((entry) => {
      const elision = retainPersistableSummarySources(entry.sources, entry.summaryLines);
      if (elision.sources.length === 0) {
        return [];
      }
      return [
        {
          // Runtime grouping includes sensitive authority and prompt fields. Each
          // persisted elision already preserves its group boundary and sources.
          contextKey: "",
          count: elision.sources.length,
          sources: elision.sources.map(toPersistedRun),
          summaryLines: elision.lines,
        },
      ];
    }),
    evictedSummaryCount: queue.evictedSummaryCount,
    ...(queue.lastRun !== undefined ? { lastRun: projectRunForPersist(queue.lastRun) } : {}),
  };
}

export function rehydratePersistedFollowupRun(
  persisted: PersistedFollowupRun,
  currentConfig: OpenClawConfig,
  explicitSkillSelections?: RestoredExplicitSkillSelections,
): FollowupRun {
  const {
    toolsAllowIntersection: persistedIntersection,
    roleDependent: _roleDependent,
    delegatedAuthority: _delegatedAuthority,
    canceled: _canceled,
    delivered: _delivered,
    discarded: _discarded,
    inlineImagesElided: _inlineImagesElided,
    explicitSkillSelections: _persistedSkillSelections,
    ...rest
  } = persisted;
  delete asWritableRecord(rest).currentInboundContext;
  // Image-bearing rows fail-close before rehydrate; strip legacy payloads
  // defensively so raw bytes can never flow into a restored run.
  delete asWritableRecord(rest).images;
  const restored: FollowupRun = {
    ...rest,
    run: rehydrateRun(persisted.run, currentConfig),
  };
  // Restored entries never carry sender identity: sender-bound turns are not
  // persisted and legacy rows that carry it fail closed. Collect grouping keys
  // on those fields, so identity-less entries still must not share a batch.
  restored.disableCollectBatching = true;
  if (explicitSkillSelections) {
    restored.explicitSkillSelections = explicitSkillSelections;
  }
  if (restored.toolsAllow) {
    restored.toolsAllow = [...restored.toolsAllow];
    const intersection = parseToolsAllowIntersection(persistedIntersection);
    if (intersection) {
      attachToolAllowlistIntersection(restored.toolsAllow, intersection);
    }
  }
  return restored;
}

export type {
  PersistedFollowupRun,
  PersistedQueueEntry,
  PersistedRunFields,
} from "./persist-codec.types.js";
