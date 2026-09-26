import type { ResolvedChannelImplicitMentions } from "../../config/implicit-mentions.js";
import type { AccessGroupConfig } from "../../config/types.access-groups.js";
import type { ChatChannelId } from "../ids.js";
import type { InboundImplicitMentionKind, InboundMentionFacts } from "../mention-gating.js";
import type { IdentifierAuthentication } from "./identifier-authentication.js";

export type ChannelIngressChannelId = ChatChannelId;

export type ChannelIngressIdentifierKind =
  | "stable-id"
  | "username"
  | "email"
  | "phone"
  | "role"
  | `plugin:${string}`;

/** Public, redacted identifier material that can participate in allowlist matching. */
type MatchableIdentifier = {
  opaqueId: string;
  kind: ChannelIngressIdentifierKind;
  authentication?: IdentifierAuthentication;
  /** @deprecated Use `authentication: "mutable"`. Remove in the next Plugin SDK major. */
  dangerous?: boolean;
  sensitivity?: "normal" | "pii";
};

/** Internal identifier material with the raw comparable value retained. */
type InternalMatchMaterial = MatchableIdentifier & {
  value: string;
};

export type InternalChannelIngressSubject = {
  identifiers: InternalMatchMaterial[];
};

/** SDK inputs remain optional; kernel consumers receive resolved authentication. */
export type NormalizedIngressSubject = {
  identifiers: Array<InternalMatchMaterial & { authentication: IdentifierAuthentication }>;
};

/** Public, redacted form of a normalized allowlist entry. */
type ChannelIngressNormalizedEntry = {
  opaqueEntryId: string;
  kind: ChannelIngressIdentifierKind;
  wildcard?: boolean;
  authentication?: IdentifierAuthentication;
  /** @deprecated Use `authentication: "mutable"`. Remove in the next Plugin SDK major. */
  dangerous?: boolean;
  sensitivity?: "normal" | "pii";
};

/** Internal normalized allowlist entry with its raw comparable value retained. */
export type InternalNormalizedEntry = ChannelIngressNormalizedEntry & {
  value: string;
  identityFieldKey?: string;
};

export type NormalizedIngressEntry = InternalNormalizedEntry & {
  authentication: IdentifierAuthentication;
};

export type RedactedIngressEntryDiagnostic = {
  opaqueEntryId?: string;
  reasonCode: IngressReasonCode;
};

export type RedactedIngressMatch = {
  matched: boolean;
  matchedEntryIds: string[];
  /** Exact redacted entry-to-subject edges retained for authentication policy. */
  matchedPairs?: RedactedIngressMatchedPair[];
};

type RedactedIngressMatchedPair = {
  opaqueEntryId: string;
  opaqueSubjectId: string;
  subjectAuthentication: IdentifierAuthentication;
};

type InternalChannelIngressNormalizeResult = {
  matchable: InternalNormalizedEntry[];
  invalid: RedactedIngressEntryDiagnostic[];
  disabled: RedactedIngressEntryDiagnostic[];
};

/** Adapter that gives the shared ingress kernel channel-specific identity matching. */
export type InternalChannelIngressAdapter = {
  normalizeEntries(params: {
    entries: readonly string[];
    context: "dm" | "group" | "route" | "command";
    accountId: string;
  }): InternalChannelIngressNormalizeResult | Promise<InternalChannelIngressNormalizeResult>;

  matchSubject(params: {
    subject: NormalizedIngressSubject;
    entries: readonly NormalizedIngressEntry[];
    context: "dm" | "group" | "route" | "command";
  }): RedactedIngressMatch | Promise<RedactedIngressMatch>;
};

export type AccessGroupMembershipFact =
  | {
      kind: "matched";
      groupName: string;
      source: "static" | "dynamic";
      matchedEntryIds: string[];
    }
  | {
      kind: "not-matched";
      groupName: string;
      source: "static" | "dynamic";
    }
  | {
      kind: "missing" | "unsupported" | "failed";
      groupName: string;
      source: "static" | "dynamic";
      reasonCode: IngressReasonCode;
      diagnosticId?: string;
    };

export type ResolvedIngressAllowlist = {
  rawEntryCount: number;
  normalizedEntries: ChannelIngressNormalizedEntry[];
  invalidEntries: RedactedIngressEntryDiagnostic[];
  disabledEntries: RedactedIngressEntryDiagnostic[];
  matchedEntryIds: string[];
  hasConfiguredEntries: boolean;
  hasMatchableEntries: boolean;
  hasWildcard: boolean;
  accessGroups: {
    referenced: string[];
    matched: string[];
    missing: string[];
    unsupported: string[];
    failed: string[];
  };
  match: RedactedIngressMatch;
  authentication?: RedactedIdentifierAuthenticationResult;
};

export type NormalizedIngressAllowlist = Omit<ResolvedIngressAllowlist, "normalizedEntries"> & {
  normalizedEntries: Array<
    ChannelIngressNormalizedEntry & { authentication: IdentifierAuthentication }
  >;
};

type RedactedIdentifierAuthenticationResult = {
  evaluated: boolean;
  threshold: IdentifierAuthentication;
  affectedMatch: boolean;
  rejectedEntryIds: string[];
};

type RedactedIdentifierAuthenticationDecision = {
  evaluated: boolean;
  affectedMatch: boolean;
};

export type RedactedIngressAllowlistFacts = {
  configured: boolean;
  matched: boolean;
  reasonCode: IngressReasonCode;
  matchedEntryIds: string[];
  invalidEntryCount: number;
  disabledEntryCount: number;
  accessGroups: ResolvedIngressAllowlist["accessGroups"];
};

type RouteGateState = "not-configured" | "matched" | "not-matched" | "disabled" | "lookup-failed";

/** How a matched route affects sender allowlist evaluation. */
type RouteSenderPolicy = "inherit" | "replace" | "deny-when-empty";

/** Source list used when a route sender policy contributes sender entries. */
type RouteSenderAllowlistSource = "effective-dm" | "effective-group";

export type RouteGateFacts = {
  id: string;
  kind: "route" | "routeSender" | "membership" | "ownerAllowlist" | "nestedAllowlist";
  gate: RouteGateState;
  effect: "allow" | "block-dispatch" | "ignore";
  precedence: number;
  senderPolicy: RouteSenderPolicy;
  senderAllowFrom?: Array<string | number>;
  senderAllowFromSource?: RouteSenderAllowlistSource;
  match?: RedactedIngressMatch;
};

type ResolvedRouteGateFacts = Omit<RouteGateFacts, "senderAllowFrom" | "senderAllowFromSource"> & {
  senderAllowlist?: ResolvedIngressAllowlist;
};

/** Inbound event facts used to choose command, pairing, and origin-subject rules. */
export type ChannelIngressEventInput = {
  kind:
    | "message"
    | "reaction"
    | "button"
    | "postback"
    | "native-command"
    | "slash-command"
    | "system";
  authMode: "inbound" | "command" | "origin-subject" | "route-only" | "none";
  mayPair: boolean;
  originSubject?: InternalChannelIngressSubject;
};

type RedactedChannelIngressEvent = Omit<ChannelIngressEventInput, "originSubject"> & {
  hasOriginSubject: boolean;
  originSubjectMatched: boolean;
  originSubjectAuthentication?: IdentifierAuthentication;
};

export type ChannelIngressStateInput = {
  channelId: ChannelIngressChannelId;
  accountId: string;
  subject: InternalChannelIngressSubject;
  conversation: {
    kind: "direct" | "group" | "channel";
    id: string;
    parentId?: string;
    threadId?: string;
    title?: string;
  };
  adapter: InternalChannelIngressAdapter;
  accessGroups?: Record<string, AccessGroupConfig>;
  accessGroupMembership?: readonly AccessGroupMembershipFact[];
  routeFacts?: RouteGateFacts[];
  mentionFacts?: InboundMentionFacts;
  event: ChannelIngressEventInput;
  allowlists: {
    dm?: Array<string | number>;
    group?: Array<string | number>;
    commandOwner?: Array<string | number>;
    commandGroup?: Array<string | number>;
    pairingStore?: Array<string | number>;
  };
};

export type ChannelIngressPolicyInput = {
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled";
  groupPolicy: "allowlist" | "open" | "disabled";
  groupAllowFromFallbackToAllowFrom?: boolean;
  minIdentifierAuthentication?: IdentifierAuthentication;
  /** @deprecated `enabled` maps to minimum `mutable`; otherwise minimum `asserted`. Remove in the next Plugin SDK major. */
  mutableIdentifierMatching?: "disabled" | "enabled";
  activation?: {
    requireMention: boolean;
    allowTextCommands: boolean;
    implicitMentions?: ResolvedChannelImplicitMentions;
    allowedImplicitMentionKinds?: readonly InboundImplicitMentionKind[];
    order?: "before-sender" | "after-command";
  };
  command?: {
    useAccessGroups?: boolean;
    allowTextCommands: boolean;
    hasControlCommand: boolean;
    modeWhenAccessGroupsOff?: "allow" | "deny" | "configured";
  };
};

type IngressGatePhase = "route" | "sender" | "command" | "event" | "activation";

type IngressGateKind =
  | "route"
  | "routeSender"
  | "dmSender"
  | "groupSender"
  | "membership"
  | "ownerAllowlist"
  | "nestedAllowlist"
  | "command"
  | "event"
  | "mention";

type IngressGateEffect =
  | "allow"
  | "block-dispatch"
  | "block-command"
  | "skip"
  | "observe"
  | "ignore";

export type IngressReasonCode =
  | "allowed"
  | "route_blocked"
  | "route_sender_empty"
  | "dm_policy_disabled"
  | "dm_policy_open"
  | "dm_policy_allowlisted"
  | "dm_policy_pairing_required"
  | "dm_policy_not_allowlisted"
  | "group_policy_disabled"
  | "group_policy_open"
  | "group_policy_allowed"
  | "group_policy_empty_allowlist"
  | "group_policy_not_allowlisted"
  | "command_authorized"
  | "control_command_unauthorized"
  | "event_authorized"
  | "event_unauthorized"
  | "event_pairing_not_allowed"
  | "sender_not_required"
  | "origin_subject_missing"
  | "origin_subject_not_matched"
  | "activation_allowed"
  | "activation_skipped"
  | "access_group_missing"
  | "access_group_unsupported"
  | "access_group_failed"
  | "mutable_identifier_disabled"
  | "identifier_authentication_too_weak"
  | "no_policy_match";

export type AccessGraphGate = {
  id: string;
  phase: IngressGatePhase;
  kind: IngressGateKind;
  effect: IngressGateEffect;
  allowed: boolean;
  reasonCode: IngressReasonCode;
  match?: RedactedIngressMatch;
  allowlist?: RedactedIngressAllowlistFacts;
  identifierAuthentication?: RedactedIdentifierAuthenticationDecision;
  sender?: {
    policy: ChannelIngressPolicyInput["dmPolicy"] | ChannelIngressPolicyInput["groupPolicy"];
  };
  command?: {
    useAccessGroups: boolean;
    allowTextCommands: boolean;
    modeWhenAccessGroupsOff?: "allow" | "deny" | "configured";
    shouldBlockControlCommand: boolean;
  };
  event?: RedactedChannelIngressEvent;
  activation?: {
    hasMentionFacts: boolean;
    requireMention: boolean;
    allowTextCommands: boolean;
    allowedImplicitMentionKinds?: readonly InboundImplicitMentionKind[];
    order?: "before-sender" | "after-command";
    shouldSkip: boolean;
    canDetectMention?: boolean;
    wasMentioned?: boolean;
    hasAnyMention?: boolean;
    implicitMentionKinds?: readonly InboundImplicitMentionKind[];
    effectiveWasMentioned?: boolean;
    shouldBypassMention?: boolean;
  };
};

/** Normalized ingress state before policy gates are reduced into a decision. */
export type ChannelIngressState = {
  channelId: ChannelIngressChannelId;
  accountId: string;
  conversationKind: "direct" | "group" | "channel";
  event: RedactedChannelIngressEvent;
  mentionFacts?: InboundMentionFacts;
  routeFacts: ResolvedRouteGateFacts[];
  allowlists: {
    dm: ResolvedIngressAllowlist;
    pairingStore: ResolvedIngressAllowlist;
    group: ResolvedIngressAllowlist;
    commandOwner: ResolvedIngressAllowlist;
    commandGroup: ResolvedIngressAllowlist;
  };
};

export type NormalizedIngressState = Omit<ChannelIngressState, "allowlists" | "routeFacts"> & {
  allowlists: {
    [K in keyof ChannelIngressState["allowlists"]]: NormalizedIngressAllowlist;
  };
  routeFacts: Array<
    Omit<ResolvedRouteGateFacts, "senderAllowlist"> & {
      senderAllowlist?: NormalizedIngressAllowlist;
    }
  >;
};

export type ChannelIngressDecision = {
  admission: "dispatch" | "observe" | "skip" | "drop" | "pairing-required";
  decision: "allow" | "block" | "pairing";
  decisiveGateId: string;
  reasonCode: IngressReasonCode;
  graph: { gates: AccessGraphGate[] };
};
