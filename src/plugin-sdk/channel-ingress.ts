import { normalizeStringEntries } from "../../packages/normalization-core/src/string-normalization.js";
import {
  decideChannelIngress,
  resolveChannelIngressState as resolveChannelIngressStateInternal,
} from "../channels/message-access/index.js";
import type {
  AccessGraphGate,
  ChannelIngressDecision,
  ChannelIngressIdentifierKind,
  ChannelIngressPolicyInput,
  ChannelIngressState,
  ChannelIngressStateInput as MessageAccessChannelIngressStateInput,
  IngressGateKind,
  IngressGatePhase,
  InternalChannelIngressAdapter,
  InternalChannelIngressNormalizeResult,
  InternalChannelIngressSubject,
  InternalMatchMaterial,
  InternalNormalizedEntry,
  IngressReasonCode,
} from "../channels/message-access/index.js";
import type { AccessFacts, ChannelTurnAdmission } from "../channels/turn/types.js";
import type {
  DmGroupAccessDecision,
  DmGroupAccessReasonCode,
} from "../security/dm-policy-shared.js";

export { decideChannelIngress };
export type {
  AccessGraph,
  AccessGraphGate,
  AccessGroupMembershipFact,
  ChannelIngressAdmission,
  ChannelIngressChannelId,
  ChannelIngressDecision,
  ChannelIngressEventInput,
  ChannelIngressIdentifierKind,
  ChannelIngressNormalizedEntry,
  ChannelIngressPolicyInput,
  ChannelIngressState,
  IngressGateEffect,
  IngressGateKind,
  IngressGatePhase,
  IngressReasonCode,
  MatchableIdentifier,
  RedactedChannelIngressEvent,
  RedactedIngressAllowlistFacts,
  RedactedIngressEntryDiagnostic,
  RedactedIngressMatch,
  ResolvedIngressAllowlist,
  ResolvedRouteGateFacts,
  RouteGateFacts,
  RouteGateState,
  RouteSenderAllowlistSource,
  RouteSenderPolicy,
} from "../channels/message-access/index.js";

export type ChannelIngressSubjectIdentifier = InternalMatchMaterial;
export type ChannelIngressSubject = InternalChannelIngressSubject;
export type ChannelIngressAdapterEntry = InternalNormalizedEntry;
export type ChannelIngressAdapterNormalizeResult = InternalChannelIngressNormalizeResult;
export type ChannelIngressAdapter = InternalChannelIngressAdapter;
export type ChannelIngressStateInput = MessageAccessChannelIngressStateInput;

declare const CHANNEL_INGRESS_PLUGIN_ID: unique symbol;

/** Branded plugin id used when channel ingress state needs to retain plugin ownership. */
export type ChannelIngressPluginId = string & {
  readonly [CHANNEL_INGRESS_PLUGIN_ID]: true;
};

export type ChannelIngressGateSelector = {
  /** Decision graph phase to inspect, such as sender, command, activation, or event. */
  phase: IngressGatePhase;
  /** Gate kind inside the selected phase. */
  kind: IngressGateKind;
};

export type ChannelIngressDecisionBundle = {
  /** Base policy applied to direct-message state. */
  dm: ChannelIngressDecision;
  /** Base policy applied to group-message state. */
  group: ChannelIngressDecision;
  /** Command policy applied to direct-message state. */
  dmCommand: ChannelIngressDecision;
  /** Command policy applied to group-message state. */
  groupCommand: ChannelIngressDecision;
};

export type ChannelIngressSideEffectResult =
  /** No reply, history write, or local event handler consumed the admission. */
  | { kind: "none" }
  /** Pairing was requested and the caller successfully notified the sender. */
  | { kind: "pairing-reply-sent" }
  /** Pairing was required, but the notification path failed. */
  | { kind: "pairing-reply-failed"; errorCode?: string }
  /** A denied/handled command produced a reply, so the turn is consumed. */
  | { kind: "command-reply-sent" }
  /** Command handling intended to reply, but delivery failed. */
  | { kind: "command-reply-failed"; errorCode?: string }
  /** The caller recorded skipped pending history and no model turn should run. */
  | { kind: "pending-history-recorded" }
  /** Local event handling fully consumed the event before model dispatch. */
  | { kind: "local-event-handled" };

export type RedactedIngressDiagnostics = {
  /** Gate id that made the final decision, safe for logs after policy redaction. */
  decisiveGateId?: string;
  /** Stable machine reason for telemetry, logs, and support diagnostics. */
  reasonCode: IngressReasonCode;
};

export const CHANNEL_INGRESS_GATE_SELECTORS = {
  command: { phase: "command", kind: "command" },
  activation: { phase: "activation", kind: "mention" },
  dmSender: { phase: "sender", kind: "dmSender" },
  groupSender: { phase: "sender", kind: "groupSender" },
  event: { phase: "event", kind: "event" },
} as const satisfies Record<string, ChannelIngressGateSelector>;

export type ChannelIngressSubjectIdentifierInput = {
  /** Raw identifier before adapter normalization, for example a sender id or address. */
  value: string;
  /** Caller-stable id used in diagnostics instead of exposing the raw value. */
  opaqueId?: string;
  /** Identifier namespace; only entries with the same kind can match by default. */
  kind?: ChannelIngressIdentifierKind;
  /** Marks values that should be treated cautiously in diagnostics or policy output. */
  dangerous?: boolean;
  /** Redaction hint for identifiers that may carry PII. */
  sensitivity?: "normal" | "pii";
};

export type CreateChannelIngressStringAdapterParams = {
  /** Identifier namespace produced for every normalized allowlist entry. */
  kind?: ChannelIngressIdentifierKind;
  /** Normalizes stored allowlist entries; null/empty results are ignored. */
  normalizeEntry?: (value: string) => string | null | undefined;
  /** Normalizes subject identifiers before matching; defaults to `normalizeEntry`. */
  normalizeSubject?: (value: string) => string | null | undefined;
  /** Detects wildcard entries before normal entry normalization runs. */
  isWildcardEntry?: (value: string) => boolean;
  /** Provides opaque ids for diagnostics; defaults to stable entry positions. */
  resolveEntryId?: (params: { entry: string; index: number }) => string;
  /** Propagates dangerous-value metadata from raw entries into normalized entries. */
  dangerous?: boolean | ((entry: string) => boolean);
  /** Redaction hint attached to every normalized entry from this adapter. */
  sensitivity?: "normal" | "pii";
};

export type CreateChannelIngressMultiIdentifierAdapterParams = {
  /** Expands one stored entry into one or more matchable identifiers. */
  normalizeEntry: (entry: string, index: number) => readonly ChannelIngressAdapterEntry[];
  /** Converts a normalized entry to a comparison key; null makes the entry unmatchable. */
  getEntryMatchKey?: (entry: ChannelIngressAdapterEntry) => string | null | undefined;
  /** Converts a subject identifier to all comparison keys it may satisfy. */
  getSubjectMatchKeys?: (
    identifier: ChannelIngressSubjectIdentifier,
  ) => readonly (string | null | undefined)[];
  /** Detects entries that should match every subject regardless of comparison keys. */
  isWildcardEntry?: (entry: ChannelIngressAdapterEntry) => boolean;
};

export type ChannelIngressDmGroupAccessProjection = {
  /** Legacy allow/block/pairing decision projected from the ingress graph. */
  decision: DmGroupAccessDecision;
  /** Legacy reason code for callers that have not migrated to graph gates. */
  reasonCode: DmGroupAccessReasonCode;
  /** Human-readable policy explanation used by older diagnostics. */
  reason: string;
};

export type ChannelIngressSenderGroupAccessProjection = {
  /** True only when the sender gate reason is allowed and the decision itself allowed. */
  allowed: boolean;
  /** Effective group policy used for the sender decision. */
  groupPolicy: ChannelIngressPolicyInput["groupPolicy"];
  /** True when a provider without route facts fell back to missing-provider policy. */
  providerMissingFallbackApplied: boolean;
  /** Compact legacy reason for group sender authorization. */
  reason: "allowed" | "disabled" | "empty_allowlist" | "sender_not_allowlisted";
};

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export type ResolveChannelIngressAccessParams = ChannelIngressStateInput & {
  policy: ChannelIngressPolicyInput;
  effectiveAllowFrom?: readonly string[];
  effectiveGroupAllowFrom?: readonly string[];
};

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export type ResolvedChannelIngressAccess = {
  /** Normalized state passed to the ingress decision engine. */
  state: ChannelIngressState;
  /** Full ingress graph and final decision. */
  ingress: ChannelIngressDecision;
  /** True when the source conversation is any non-direct channel. */
  isGroup: boolean;
  /** Sender gate reason projected for legacy callers. */
  senderReasonCode: IngressReasonCode;
  /** Legacy DM/group policy projection plus caller-supplied effective allowlists. */
  access: ChannelIngressDmGroupAccessProjection & {
    effectiveAllowFrom: string[];
    effectiveGroupAllowFrom: string[];
  };
  /** Whether the command gate allowed the control command path. */
  commandAuthorized: boolean;
  /** Whether command handling should stop before model dispatch. */
  shouldBlockControlCommand: boolean;
};

function defaultNormalize(value: string): string {
  return value;
}

function normalizeMatchValue(
  value: string,
  normalize: (value: string) => string | null | undefined,
): string | null {
  const normalized = normalize(value);
  return normalized == null ? null : normalized.trim() || null;
}

function resolveDangerous(
  dangerous: CreateChannelIngressStringAdapterParams["dangerous"],
  entry: string,
): boolean | undefined {
  return typeof dangerous === "function" ? dangerous(entry) : dangerous;
}

function defaultIngressMatchKey(params: {
  kind: ChannelIngressIdentifierKind;
  value: string;
}): string {
  return `${params.kind}:${params.value}`;
}

export function findChannelIngressGate(
  decision: ChannelIngressDecision,
  selector: ChannelIngressGateSelector,
): AccessGraphGate | undefined {
  return decision.graph.gates.find(
    (gate) => gate.phase === selector.phase && gate.kind === selector.kind,
  );
}

/** Finds the sender gate that applies to direct or group policy checks. */
export function findChannelIngressSenderGate(
  decision: ChannelIngressDecision,
  params: { isGroup: boolean },
): AccessGraphGate | undefined {
  return findChannelIngressGate(
    decision,
    params.isGroup
      ? CHANNEL_INGRESS_GATE_SELECTORS.groupSender
      : CHANNEL_INGRESS_GATE_SELECTORS.dmSender,
  );
}

/** Finds the command gate used to decide control-command handling. */
export function findChannelIngressCommandGate(
  decision: ChannelIngressDecision,
): AccessGraphGate | undefined {
  return findChannelIngressGate(decision, CHANNEL_INGRESS_GATE_SELECTORS.command);
}

/** Resolves base and command decisions for direct and group state in one pass. */
export function decideChannelIngressBundle(params: {
  /** Direct-message state resolved from the same event facts. */
  directState: ChannelIngressState;
  /** Group/channel state resolved from the same event facts. */
  groupState: ChannelIngressState;
  /** Normal message policy without command-specific overrides. */
  basePolicy: ChannelIngressPolicyInput;
  /** Command policy with control-command authorizer overrides applied. */
  commandPolicy: ChannelIngressPolicyInput;
}): ChannelIngressDecisionBundle {
  return {
    dm: decideChannelIngress(params.directState, params.basePolicy),
    group: decideChannelIngress(params.groupState, params.basePolicy),
    dmCommand: decideChannelIngress(params.directState, params.commandPolicy),
    groupCommand: decideChannelIngress(params.groupState, params.commandPolicy),
  };
}

function projectGroupPolicy(
  gate: AccessGraphGate | undefined,
): NonNullable<AccessFacts["group"]>["policy"] {
  const policy = gate?.sender?.policy;
  return policy === "open" || policy === "disabled" ? policy : "allowlist";
}

function projectMentionFacts(gate: AccessGraphGate | undefined): AccessFacts["mentions"] {
  const activation = gate?.activation;
  if (!activation?.hasMentionFacts) {
    return undefined;
  }
  return {
    canDetectMention: activation.canDetectMention ?? false,
    wasMentioned: activation.wasMentioned ?? false,
    hasAnyMention: activation.hasAnyMention,
    implicitMentionKinds: activation.implicitMentionKinds
      ? [...activation.implicitMentionKinds]
      : undefined,
    requireMention: activation.requireMention,
    effectiveWasMentioned: activation.effectiveWasMentioned,
    shouldSkip: activation.shouldSkip,
  };
}

function projectDmDecision(
  decision: ChannelIngressDecision,
  dmSender: AccessGraphGate | undefined,
): NonNullable<AccessFacts["dm"]>["decision"] {
  if (decision.decision === "pairing") {
    return "pairing";
  }
  if (dmSender) {
    return dmSender.allowed ? "allow" : "deny";
  }
  return decision.admission === "drop" ? "deny" : "allow";
}

/** Projects the detailed ingress graph into the older turn access-facts shape. */
export function projectIngressAccessFacts(
  /** Detailed ingress decision graph to expose through the legacy AccessFacts API. */
  decision: ChannelIngressDecision,
): AccessFacts {
  const command = findChannelIngressGate(decision, CHANNEL_INGRESS_GATE_SELECTORS.command);
  const activation = findChannelIngressGate(decision, CHANNEL_INGRESS_GATE_SELECTORS.activation);
  const dmSender = findChannelIngressGate(decision, CHANNEL_INGRESS_GATE_SELECTORS.dmSender);
  const groupSender = findChannelIngressGate(decision, CHANNEL_INGRESS_GATE_SELECTORS.groupSender);
  const event = findChannelIngressGate(decision, CHANNEL_INGRESS_GATE_SELECTORS.event);
  return {
    dm: {
      decision: projectDmDecision(decision, dmSender),
      reason: dmSender?.reasonCode ?? decision.reasonCode,
      allowFrom: [],
      allowlist: dmSender?.allowlist,
    },
    group: {
      policy: projectGroupPolicy(groupSender),
      routeAllowed: !decision.graph.gates.some(
        (gate) => gate.phase === "route" && gate.effect === "block-dispatch",
      ),
      senderAllowed: groupSender?.allowed ?? dmSender?.allowed ?? false,
      allowFrom: [],
      requireMention: activation?.activation?.requireMention ?? false,
      allowlist: groupSender?.allowlist,
    },
    commands: command?.command
      ? {
          authorized: command.allowed,
          shouldBlockControlCommand: command.command.shouldBlockControlCommand,
          reasonCode: command.reasonCode,
          useAccessGroups: command.command.useAccessGroups,
          allowTextCommands: command.command.allowTextCommands,
          modeWhenAccessGroupsOff: command.command.modeWhenAccessGroupsOff,
          // Legacy AccessFacts requires authorizer rows, but the ingress graph
          // only exposes redacted aggregate matches. Keep the field present and empty.
          authorizers: [],
        }
      : undefined,
    event: event?.event
      ? {
          ...event.event,
          authorized: event.allowed,
          reasonCode: event.reasonCode,
        }
      : undefined,
    mentions: projectMentionFacts(activation),
  };
}

/** Combines the ingress admission and caller side effects into turn-queue admission. */
export function mapChannelIngressDecisionToTurnAdmission(
  decision: ChannelIngressDecision,
  sideEffect: ChannelIngressSideEffectResult,
): ChannelTurnAdmission {
  if (decision.admission === "dispatch") {
    return { kind: "dispatch", reason: decision.reasonCode };
  }
  if (decision.admission === "observe") {
    return { kind: "observeOnly", reason: decision.reasonCode };
  }
  if (decision.admission === "pairing-required") {
    return sideEffect.kind === "pairing-reply-sent"
      ? { kind: "handled", reason: decision.reasonCode }
      : { kind: "drop", reason: decision.reasonCode };
  }
  if (decision.admission === "skip") {
    return sideEffect.kind === "pending-history-recorded" ||
      sideEffect.kind === "local-event-handled" ||
      sideEffect.kind === "command-reply-sent"
      ? { kind: "handled", reason: decision.reasonCode }
      : { kind: "drop", reason: decision.reasonCode, recordHistory: false };
  }
  return sideEffect.kind === "local-event-handled" || sideEffect.kind === "command-reply-sent"
    ? { kind: "handled", reason: decision.reasonCode }
    : { kind: "drop", reason: decision.reasonCode };
}

/** Creates a non-empty branded id for SDK call sites that track plugin ownership. */
export function createChannelIngressPluginId(id: string): ChannelIngressPluginId {
  const trimmed = id.trim();
  if (!trimmed) {
    throw new Error("Channel ingress plugin id must be non-empty.");
  }
  return trimmed as ChannelIngressPluginId;
}

/** Builds a match subject from one or more raw identifiers with opaque defaults. */
export function createChannelIngressSubject(
  input:
    | ChannelIngressSubjectIdentifierInput
    | { identifiers: readonly ChannelIngressSubjectIdentifierInput[] },
): ChannelIngressSubject {
  const identifiers = "identifiers" in input ? input.identifiers : [input];
  return {
    identifiers: identifiers.map((identifier, index) => ({
      opaqueId: identifier.opaqueId ?? `subject-${index + 1}`,
      kind: identifier.kind ?? "stable-id",
      value: identifier.value,
      dangerous: identifier.dangerous,
      sensitivity: identifier.sensitivity,
    })),
  };
}

/** Creates an adapter for one identifier kind with simple string normalization. */
export function createChannelIngressStringAdapter(
  params: CreateChannelIngressStringAdapterParams = {},
): ChannelIngressAdapter {
  const kind = params.kind ?? "stable-id";
  const normalizeEntry = params.normalizeEntry ?? defaultNormalize;
  const normalizeSubject = params.normalizeSubject ?? normalizeEntry;
  const isWildcardEntry = params.isWildcardEntry ?? ((entry: string) => entry === "*");
  return {
    normalizeEntries({ entries }) {
      const matchable = normalizeStringEntries(entries).flatMap((entry, index) => {
        const value = isWildcardEntry(entry) ? "*" : normalizeMatchValue(entry, normalizeEntry);
        if (!value) {
          return [];
        }
        return [
          {
            opaqueEntryId: params.resolveEntryId?.({ entry, index }) ?? `entry-${index + 1}`,
            kind,
            value,
            dangerous: resolveDangerous(params.dangerous, entry),
            sensitivity: params.sensitivity,
          },
        ];
      });
      return {
        matchable,
        invalid: [],
        disabled: [],
      };
    },
    matchSubject({ subject, entries }) {
      const values = new Set(
        subject.identifiers.flatMap((identifier) => {
          if (identifier.kind !== kind) {
            return [];
          }
          const value = normalizeMatchValue(identifier.value, normalizeSubject);
          return value ? [value] : [];
        }),
      );
      const matchedEntryIds = entries
        .filter((entry) => entry.kind === kind && (entry.value === "*" || values.has(entry.value)))
        .map((entry) => entry.opaqueEntryId);
      return {
        matched: matchedEntryIds.length > 0,
        matchedEntryIds,
      };
    },
  };
}

/** Creates an adapter for entries that can expand to multiple identifier kinds. */
export function createChannelIngressMultiIdentifierAdapter(
  params: CreateChannelIngressMultiIdentifierAdapterParams,
): ChannelIngressAdapter {
  const getEntryMatchKey = params.getEntryMatchKey ?? defaultIngressMatchKey;
  const getSubjectMatchKeys =
    params.getSubjectMatchKeys ??
    ((identifier: ChannelIngressSubjectIdentifier) => [defaultIngressMatchKey(identifier)]);
  const isWildcardEntry = params.isWildcardEntry ?? ((entry) => entry.value === "*");
  return {
    normalizeEntries({ entries }) {
      return {
        matchable: entries.flatMap((entry, index) => params.normalizeEntry(entry, index)),
        invalid: [],
        disabled: [],
      };
    },
    matchSubject({ subject, entries }) {
      const subjectKeys = new Set(
        subject.identifiers.flatMap((identifier) =>
          getSubjectMatchKeys(identifier).filter((key): key is string => Boolean(key)),
        ),
      );
      const matchedEntryIds = entries
        .filter((entry) => {
          if (isWildcardEntry(entry)) {
            return true;
          }
          const key = getEntryMatchKey(entry);
          return key ? subjectKeys.has(key) : false;
        })
        .map((entry) => entry.opaqueEntryId);
      return {
        matched: matchedEntryIds.length > 0,
        matchedEntryIds,
      };
    },
  };
}

export function assertNeverChannelIngressReason(reasonCode: never): never {
  throw new Error(`Unhandled channel ingress reason code: ${String(reasonCode)}`);
}

/** @deprecated Use `senderAccess.reasonCode` from `resolveChannelMessageIngress(...)` or typed gate selectors. */
export function findChannelIngressSenderReasonCode(
  decision: ChannelIngressDecision,
  params: { isGroup: boolean },
): IngressReasonCode {
  return findChannelIngressSenderGate(decision, params)?.reasonCode ?? decision.reasonCode;
}

/** @deprecated Use `senderAccess.reasonCode` from `resolveChannelMessageIngress(...)`. */
export function mapChannelIngressReasonCodeToDmGroupAccessReason(params: {
  reasonCode: IngressReasonCode;
  isGroup: boolean;
}): DmGroupAccessReasonCode {
  switch (params.reasonCode) {
    case "group_policy_open":
    case "group_policy_allowed":
      return "group_policy_allowed";
    case "group_policy_disabled":
      return "group_policy_disabled";
    case "route_sender_empty":
    case "group_policy_empty_allowlist":
      return "group_policy_empty_allowlist";
    case "group_policy_not_allowlisted":
      return "group_policy_not_allowlisted";
    case "dm_policy_open":
      return "dm_policy_open";
    case "dm_policy_disabled":
      return "dm_policy_disabled";
    case "dm_policy_allowlisted":
      return "dm_policy_allowlisted";
    case "dm_policy_pairing_required":
      return "dm_policy_pairing_required";
    default:
      return params.isGroup ? "group_policy_not_allowlisted" : "dm_policy_not_allowlisted";
  }
}

/** @deprecated Use `senderAccess.reason` from `resolveChannelMessageIngress(...)`. */
export function formatChannelIngressPolicyReason(params: {
  reasonCode: DmGroupAccessReasonCode;
  dmPolicy: string;
  groupPolicy: string;
}): string {
  switch (params.reasonCode) {
    case "group_policy_allowed":
      return `groupPolicy=${params.groupPolicy}`;
    case "group_policy_disabled":
      return "groupPolicy=disabled";
    case "group_policy_empty_allowlist":
      return "groupPolicy=allowlist (empty allowlist)";
    case "group_policy_not_allowlisted":
      return "groupPolicy=allowlist (not allowlisted)";
    case "dm_policy_open":
      return "dmPolicy=open";
    case "dm_policy_disabled":
      return "dmPolicy=disabled";
    case "dm_policy_allowlisted":
      return `dmPolicy=${params.dmPolicy} (allowlisted)`;
    case "dm_policy_pairing_required":
      return "dmPolicy=pairing (not allowlisted)";
    case "dm_policy_not_allowlisted":
      return `dmPolicy=${params.dmPolicy} (not allowlisted)`;
  }
  const exhaustive: never = params.reasonCode;
  return exhaustive;
}

/** @deprecated Use `senderAccess.groupAccess` from `resolveChannelMessageIngress(...)`. */
export function projectChannelIngressSenderGroupAccess(params: {
  reasonCode: IngressReasonCode;
  decisionAllowed: boolean;
  groupPolicy: ChannelIngressPolicyInput["groupPolicy"];
  providerMissingFallbackApplied?: boolean;
}): ChannelIngressSenderGroupAccessProjection {
  const reasonCode = mapChannelIngressReasonCodeToDmGroupAccessReason({
    reasonCode: params.reasonCode,
    isGroup: true,
  });
  const reason =
    params.groupPolicy === "disabled" || reasonCode === "group_policy_disabled"
      ? "disabled"
      : reasonCode === "group_policy_empty_allowlist"
        ? "empty_allowlist"
        : reasonCode === "group_policy_not_allowlisted"
          ? "sender_not_allowlisted"
          : "allowed";
  return {
    allowed: reason === "allowed" && params.decisionAllowed,
    groupPolicy: params.groupPolicy,
    providerMissingFallbackApplied: params.providerMissingFallbackApplied ?? false,
    reason,
  };
}

/** @deprecated Use `senderAccess` from `resolveChannelMessageIngress(...)`. */
export function projectChannelIngressDmGroupAccess(params: {
  ingress: ChannelIngressDecision;
  isGroup: boolean;
  dmPolicy: string;
  groupPolicy: string;
}): ChannelIngressDmGroupAccessProjection {
  const reasonCode = mapChannelIngressReasonCodeToDmGroupAccessReason({
    reasonCode: findChannelIngressSenderReasonCode(params.ingress, { isGroup: params.isGroup }),
    isGroup: params.isGroup,
  });
  const decision: DmGroupAccessDecision =
    reasonCode === "dm_policy_pairing_required"
      ? "pairing"
      : params.ingress.decision === "allow"
        ? "allow"
        : "block";
  const reason = formatChannelIngressPolicyReason({
    reasonCode,
    dmPolicy: params.dmPolicy,
    groupPolicy: params.groupPolicy,
  });
  return {
    decision,
    reasonCode,
    reason,
  };
}

export async function resolveChannelIngressState(
  input: ChannelIngressStateInput,
): Promise<ChannelIngressState> {
  return await resolveChannelIngressStateInternal(input);
}

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export async function resolveChannelIngressAccess(
  params: ResolveChannelIngressAccessParams,
): Promise<ResolvedChannelIngressAccess> {
  const { policy, effectiveAllowFrom, effectiveGroupAllowFrom, ...stateInput } = params;
  const state = await resolveChannelIngressState(stateInput);
  const ingress = decideChannelIngress(state, policy);
  const isGroup = params.conversation.kind !== "direct";
  const senderReasonCode = findChannelIngressSenderReasonCode(ingress, { isGroup });
  const access = projectChannelIngressDmGroupAccess({
    ingress,
    isGroup,
    dmPolicy: policy.dmPolicy,
    groupPolicy: policy.groupPolicy,
  });
  const commandGate = findChannelIngressCommandGate(ingress);
  return {
    state,
    ingress,
    isGroup,
    senderReasonCode,
    access: {
      ...access,
      effectiveAllowFrom: [...(effectiveAllowFrom ?? [])],
      effectiveGroupAllowFrom: [...(effectiveGroupAllowFrom ?? [])],
    },
    commandAuthorized: commandGate?.allowed === true,
    shouldBlockControlCommand: commandGate?.command?.shouldBlockControlCommand === true,
  };
}
