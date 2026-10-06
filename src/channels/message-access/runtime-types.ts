import type { AccessGroupConfig } from "../../config/types.access-groups.js";
import type { InboundEventKind } from "../inbound-event/kind.js";
import type { IdentifierAuthentication } from "./identifier-authentication.js";
import type {
  AccessGroupMembershipFact,
  AccessGraphGate,
  ChannelIngressChannelId,
  ChannelIngressDecision,
  ChannelIngressEventInput,
  ChannelIngressIdentifierKind,
  ChannelIngressPolicyInput,
  ChannelIngressState,
  ChannelIngressStateInput,
  IngressReasonCode,
  InternalChannelIngressSubject,
  InternalNormalizedEntry,
  RouteGateFacts,
} from "./types.js";

export type ChannelIngressIdentityField = {
  /** Unique field key used in subject alias maps and diagnostics. */
  key?: string;
  /** Redacted identifier kind written into the access graph. */
  kind?: ChannelIngressIdentifierKind;
  /** Shared normalizer used for both entries and subjects when no side-specific normalizer exists. */
  normalize?: (value: string) => string | null | undefined;
  normalizeEntry?: (value: string) => string | null | undefined;
  normalizeSubject?: (value: string) => string | null | undefined;
  /** Static strength of this identity field. `verified` requires owning-boundary metadata. */
  authentication?:
    | IdentifierAuthentication
    | ((value: string) => IdentifierAuthentication | undefined);
  /** @deprecated Use `authentication: "mutable"`. Remove in the next Plugin SDK major. */
  dangerous?: boolean | ((value: string) => boolean | undefined);
  /** Redaction hint for diagnostics and access graph consumers. */
  sensitivity?: "normal" | "pii";
};

export type ChannelIngressIdentityAlias = ChannelIngressIdentityField & {
  key: string;
};

/** Identity contract for a channel resolver. Plugins provide platform normalization here. */
export type ChannelIngressIdentityDescriptor = {
  /** Product identity: only when the plugin can prove the remote issuer and identifier kind. */
  resolveParticipant?: (
    subject: ChannelIngressIdentitySubjectInput,
  ) => { domain: string; idKind: string; id: string } | undefined;
  /** Primary stable identity field. Prefer immutable sender ids when the platform has one. */
  primary: ChannelIngressIdentityField;
  /** Additional identifiers that can match legacy or platform-specific allowlist entries. */
  aliases?: readonly ChannelIngressIdentityAlias[];
  /** Returns true when a raw allowlist entry should authorize every sender. */
  isWildcardEntry?: (value: string) => boolean;
  /** Optional custom match hook for platform-specific identity equivalence. */
  matchEntry?: (params: {
    subject: InternalChannelIngressSubject;
    entry: InternalNormalizedEntry;
    context: "dm" | "group" | "route" | "command";
  }) => boolean | undefined;
  /** Generates stable redacted entry ids for diagnostics. */
  resolveEntryId?: (params: {
    entry: string;
    entryIndex: number;
    fieldKey: string;
    fieldIndex: number;
  }) => string;
};

export type StableChannelIngressIdentityParams = ChannelIngressIdentityField &
  Pick<
    ChannelIngressIdentityDescriptor,
    "aliases" | "isWildcardEntry" | "matchEntry" | "resolveParticipant"
  > & {
    /** Prefix used for generated entry ids when `resolveEntryId` is omitted. */
    entryIdPrefix?: string;
    /** Custom entry-id generator used in redacted diagnostics. */
    resolveEntryId?: ChannelIngressIdentityDescriptor["resolveEntryId"];
  };

export type ChannelIngressIdentitySubjectInput = {
  /** Stable sender id appended to effective allowlists when access groups matched. */
  stableId?: string | number | null;
  /** Optional identity aliases keyed by `ChannelIngressIdentityAlias.key`. */
  aliases?: Record<string, string | number | null | undefined>;
  /** Per-message claims keyed by the exact identity field key. */
  authentication?: Record<string, IdentifierAuthentication | undefined>;
};

export type ChannelIngressConfigInput = {
  /** Static or dynamic access group definitions referenced by allowlist entries. */
  accessGroups?: ChannelIngressStateInput["accessGroups"];
} | null;

export type ChannelMessageIngressCommandInput = NonNullable<
  ChannelIngressPolicyInput["command"]
> & {
  /** Explicit command-owner allowlist; defaults to effective DM allowlist. */
  commandOwnerAllowFrom?: Array<string | number> | null;
  /** Controls whether group command owners inherit configured DM owners. */
  groupOwnerAllowFrom?: "configured" | "none";
  /** Allows direct-message command checks to reuse effective group allowlists. */
  directGroupAllowFrom?: "effective" | "none";
  /** Group command allowFrom fallback, separate from normal group sender policy. */
  commandGroupAllowFromFallbackToAllowFrom?: boolean;
};

export type ChannelIngressCommandPresetInput = Omit<
  Partial<ChannelMessageIngressCommandInput>,
  "useAccessGroups"
> & {
  /** Set false to omit the command gate entirely. */
  requested?: boolean;
  /** Internal override for this command decision. */
  useAccessGroups?: boolean | null;
  /** Config subset used to derive command access-group behavior. */
  cfg?: ChannelIngressConfigInput;
};

export type ChannelIngressEventPresetInput = Partial<ChannelIngressEventInput> & {
  /** Convenience flag used to derive pairing defaults for group events. */
  isGroup?: boolean;
};

/** Final host-context identity that an ingress result is eligible to enter once. */
export type ChannelIngressContextBinding = {
  /** Final routed agent selected by the channel producer. */
  agentId: string;
  /** Final dispatch or route session selected by the channel producer. */
  sessionKey: string;
  /** Final message id used by the host context, after any transport ID mapping. */
  messageId?: string;
  /** Match the host context's reply or conversation nativeChannelId, including when it equals id. */
  nativeChannelId?: string;
  /** Final inbound event classification used by the host context. */
  inboundEventKind: InboundEventKind;
};

/** Optional route gate, such as a room, thread, topic, guild, or group route. */
export type ChannelIngressRouteDescriptor = {
  /** Stable route id used in diagnostics. */
  id: string;
  /** Route kind for diagnostics and graph consumers. */
  kind?: RouteGateFacts["kind"];
  configured?: boolean;
  matched?: boolean;
  allowed?: boolean;
  /** Whether to include this route descriptor in the graph. */
  enabled?: boolean;
  /** Ordering hint when multiple route descriptors are supplied. */
  precedence?: number;
  /** How route sender allowlists combine with effective channel allowlists. */
  senderPolicy?: RouteGateFacts["senderPolicy"];
  senderAllowFrom?: Array<string | number> | null;
  /** Indicates whether route sender entries came from effective DM or group policy. */
  senderAllowFromSource?: RouteGateFacts["senderAllowFromSource"];
  /** Optional redacted match id for the route. */
  matchId?: string;
  /** Reason used when this route blocks the event. */
  blockReason?: string;
};

/** Dynamic access-group resolver invoked for groups that need platform lookups. */
export type ChannelIngressAccessGroupMembershipResolver = (params: {
  name: string;
  group: AccessGroupConfig;
  channelId: ChannelIngressChannelId;
  accountId: string;
  subject: ChannelIngressIdentitySubjectInput;
}) => boolean | Promise<boolean>;

export type ResolveChannelMessageIngressParams = {
  /** Channel id used for config, diagnostics, access groups, and pairing-store reads. */
  channelId: ChannelIngressChannelId;
  /** Account id scoped to this channel instance. */
  accountId: string;
  identity: ChannelIngressIdentityDescriptor;
  subject: ChannelIngressIdentitySubjectInput;
  conversation: ChannelIngressStateInput["conversation"];
  event: ChannelIngressEventInput;
  /** Exact finalized host context this result may enter; omit for decision-only checks. */
  contextBinding?: ChannelIngressContextBinding;
  policy: ChannelIngressPolicyInput;
  /** Raw direct-message allowlist entries. */
  allowFrom?: Array<string | number> | null;
  /** Raw group sender allowlist entries. */
  groupAllowFrom?: Array<string | number> | null;
  /** Route descriptors used to build route gates. */
  route?: ChannelIngressRouteDescriptor | readonly ChannelIngressRouteDescriptor[];
  /** Prebuilt route facts for lower-level callers. */
  routeFacts?: RouteGateFacts[];
  /** Access group config referenced by allowlist entries. */
  accessGroups?: ChannelIngressStateInput["accessGroups"];
  /** Precomputed access-group memberships for this subject. */
  accessGroupMembership?: readonly AccessGroupMembershipFact[];
  resolveAccessGroupMembership?: ChannelIngressAccessGroupMembershipResolver;
  /** Concrete sender entry appended to effective allowlists when an access group matched. */
  accessGroupMatchedAllowFromEntry?: string | number | null;
  providerMissingFallbackApplied?: boolean;
  mentionFacts?: ChannelIngressStateInput["mentionFacts"];
  /** Optional pairing-store reader for direct-message allowlist material. */
  readStoreAllowFrom?: (params: {
    channelId: ChannelIngressChannelId;
    accountId: string;
    dmPolicy: ChannelIngressPolicyInput["dmPolicy"];
  }) => Promise<readonly (string | number)[] | null | undefined>;
  /** Reads the default pairing store when no explicit reader is supplied. */
  useDefaultPairingStore?: boolean;
  /** Command gate input; omit when no command policy is requested. */
  command?: ChannelMessageIngressCommandInput;
};

/** Shared resolver defaults for repeated events from the same channel account. */
export type CreateChannelIngressResolverParams = Pick<
  ResolveChannelMessageIngressParams,
  | "channelId"
  | "accountId"
  | "identity"
  | "accessGroups"
  | "accessGroupMembership"
  | "resolveAccessGroupMembership"
  | "accessGroupMatchedAllowFromEntry"
  | "readStoreAllowFrom"
  | "useDefaultPairingStore"
> & {
  /** Config subset used for access groups and command behavior. */
  cfg?: ChannelIngressConfigInput;
  /** Global override for access-group expansion in this resolver. */
  useAccessGroups?: boolean | null;
  /** Default DM policy for message calls that omit it. */
  defaultDmPolicy?: ChannelIngressPolicyInput["dmPolicy"];
  /** Default group policy for message calls that omit it. */
  defaultGroupPolicy?: ChannelIngressPolicyInput["groupPolicy"];
  groupAllowFromFallbackToAllowFrom?: boolean;
  /** Weakest exact-pair identifier claim allowed to authorize. */
  minIdentifierAuthentication?: ChannelIngressPolicyInput["minIdentifierAuthentication"];
  /** @deprecated Maps to `minIdentifierAuthentication`; remove in the next Plugin SDK major. */
  mutableIdentifierMatching?: ChannelIngressPolicyInput["mutableIdentifierMatching"];
};

export type ChannelIngressResolverMessageParams = Omit<
  ResolveChannelMessageIngressParams,
  | "channelId"
  | "accountId"
  | "identity"
  | "accessGroups"
  | "resolveAccessGroupMembership"
  | "accessGroupMatchedAllowFromEntry"
  | "readStoreAllowFrom"
  | "useDefaultPairingStore"
  | "event"
  | "policy"
  | "command"
> & {
  /** Event facts or presets; defaults to a normal inbound message event. */
  event?: ChannelIngressEventPresetInput;
  dmPolicy?: ChannelIngressPolicyInput["dmPolicy"];
  groupPolicy?: ChannelIngressPolicyInput["groupPolicy"];
  /** Additional policy fields merged with resolver defaults. */
  policy?: Partial<Omit<ChannelIngressPolicyInput, "dmPolicy" | "groupPolicy">>;
  /** Command gate input, preset, or false to suppress command checks. */
  command?: ChannelIngressCommandPresetInput | false;
};

export type ChannelIngressResolver = {
  /** Resolve a normal inbound message with sender, route, command, event, and activation gates. */
  message(params: ChannelIngressResolverMessageParams): Promise<ResolvedChannelMessageIngress>;
  /** Resolve a command-oriented event with command auth defaults enabled. */
  command(params: ChannelIngressResolverMessageParams): Promise<ResolvedChannelMessageIngress>;
  /** Resolve a non-message event with event-gate defaults enabled. */
  event(params: ChannelIngressResolverMessageParams): Promise<ResolvedChannelMessageIngress>;
};

export type ResolveStableChannelMessageIngressParams = Omit<
  CreateChannelIngressResolverParams,
  "identity"
> &
  ChannelIngressResolverMessageParams & { identity?: StableChannelIngressIdentityParams };

/** Sender/conversation projection consumed by channel handlers. */
export type ChannelIngressSenderAccess = {
  allowed: boolean;
  /** Final ingress decision after all gates, not just the sender gate. */
  decision: ChannelIngressDecision["decision"];
  /** Sender gate reason when present, otherwise decisive ingress reason. */
  reasonCode: IngressReasonCode;
  /** Sender gate from the access graph, when one ran. */
  gate?: AccessGraphGate;
  /** Effective DM allowlist entries after store and access-group processing. */
  effectiveAllowFrom: string[];
  /** Effective group allowlist entries after fallback and access-group processing. */
  effectiveGroupAllowFrom: string[];
  providerMissingFallbackApplied: boolean;
};

export type ChannelIngressCommandAccess = {
  requested: boolean;
  authorized: boolean;
  shouldBlockControlCommand: boolean;
  /** Command gate reason when present, otherwise decisive ingress reason. */
  reasonCode: IngressReasonCode;
  /** Command gate from the access graph, when one ran. */
  gate?: AccessGraphGate;
};

export type ChannelIngressRouteAccess = {
  /** True when all configured route gates admit the event. */
  allowed: boolean;
  /** Route gate reason when a route gate decided. */
  reasonCode?: IngressReasonCode;
  /** Optional route-specific reason text. */
  reason?: string;
  /** Route gate from the access graph, when one ran. */
  gate?: AccessGraphGate;
};

export type ChannelIngressActivationAccess = {
  ran: boolean;
  allowed: boolean;
  /** True when the event should be skipped instead of dispatched. */
  shouldSkip: boolean;
  /** Activation gate reason when present, otherwise decisive ingress reason. */
  reasonCode: IngressReasonCode;
  /** Effective mention match after command bypass and activation policy. */
  effectiveWasMentioned?: boolean;
  /** True when mention gating was bypassed by policy or command facts. */
  shouldBypassMention?: boolean;
  /** Activation gate from the access graph, when one ran. */
  gate?: AccessGraphGate;
};

export type ResolvedChannelMessageIngress = {
  /** Redacted normalized state used as input to the decision engine. */
  state: ChannelIngressState;
  /** Ordered access graph plus final admission decision. */
  ingress: ChannelIngressDecision;
  senderAccess: ChannelIngressSenderAccess;
  routeAccess: ChannelIngressRouteAccess;
  commandAccess: ChannelIngressCommandAccess;
  activationAccess: ChannelIngressActivationAccess;
};
