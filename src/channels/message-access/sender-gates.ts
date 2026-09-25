/**
 * Channel ingress sender gate helpers.
 *
 * Evaluates DM and group sender policies against normalized allowlists.
 */
import {
  allowlistFailureReason,
  applyIdentifierAuthenticationPolicy,
  effectiveGroupSenderAllowlist,
  redactedAllowlistDiagnostics,
} from "./allowlist.js";
import type {
  AccessGraphGate,
  ChannelIngressPolicyInput,
  NormalizedIngressState,
  NormalizedIngressAllowlist,
} from "./types.js";

function senderGate(params: {
  isGroup: boolean;
  allowed: boolean;
  reasonCode: AccessGraphGate["reasonCode"];
  policy: ChannelIngressPolicyInput["dmPolicy"] | ChannelIngressPolicyInput["groupPolicy"];
  allowlistSource: NormalizedIngressAllowlist;
}): AccessGraphGate {
  // Sender gates always include redacted allowlist facts so diagnostics can explain an
  // allow/block result without exposing raw sender ids.
  return {
    id: params.isGroup ? "sender:group" : "sender:dm",
    phase: "sender",
    kind: params.isGroup ? "groupSender" : "dmSender",
    effect: params.allowed ? "allow" : "block-dispatch",
    allowed: params.allowed,
    reasonCode: params.reasonCode,
    match: params.allowlistSource.match,
    sender: { policy: params.policy },
    allowlist: redactedAllowlistDiagnostics(params.allowlistSource, params.reasonCode),
    ...(params.allowlistSource.authentication
      ? {
          identifierAuthentication: {
            evaluated: params.allowlistSource.authentication.evaluated,
            affectedMatch: params.allowlistSource.authentication.affectedMatch,
          },
        }
      : {}),
  };
}

/**
 * Evaluates direct-message sender policy against DM and pairing-store allowlists.
 */
export function senderGateForDirect(params: {
  state: NormalizedIngressState;
  policy: ChannelIngressPolicyInput;
}): AccessGraphGate {
  const dm = applyIdentifierAuthenticationPolicy(params.state.allowlists.dm, params.policy);
  const pairingStore = applyIdentifierAuthenticationPolicy(
    params.state.allowlists.pairingStore,
    params.policy,
  );
  const decide = (
    allowed: boolean,
    reasonCode: AccessGraphGate["reasonCode"],
    allowlistSource = dm,
  ) =>
    senderGate({
      isGroup: false,
      policy: params.policy.dmPolicy,
      allowlistSource,
      allowed,
      reasonCode,
    });
  if (params.policy.dmPolicy === "disabled") {
    return decide(false, "dm_policy_disabled");
  }
  if (params.policy.dmPolicy === "open") {
    // Open DM policy still requires either wildcard or an explicit normalized entry so
    // configured allowlists keep their narrowing effect.
    if (dm.hasWildcard) {
      return decide(true, "dm_policy_open");
    }
    if (dm.match.matched) {
      return decide(true, "dm_policy_allowlisted");
    }
    return decide(false, "dm_policy_not_allowlisted");
  }
  if (dm.match.matched) {
    return decide(true, "dm_policy_allowlisted");
  }
  if (params.policy.dmPolicy === "pairing" && pairingStore.match.matched) {
    // Pairing-store matches are only valid for pairing policy, never for open/allowlist modes.
    return decide(true, "dm_policy_allowlisted", pairingStore);
  }
  if (params.policy.dmPolicy === "pairing" && params.state.event.mayPair) {
    return decide(false, "dm_policy_pairing_required");
  }
  const reasonCode =
    params.policy.dmPolicy === "pairing"
      ? "event_pairing_not_allowed"
      : (allowlistFailureReason(dm) ?? "dm_policy_not_allowlisted");
  return decide(false, reasonCode);
}

/**
 * Evaluates group/channel sender policy after route sender allowlist overrides are applied.
 */
export function senderGateForGroup(params: {
  state: NormalizedIngressState;
  policy: ChannelIngressPolicyInput;
}): AccessGraphGate {
  const group = effectiveGroupSenderAllowlist(params);
  const decide = (allowed: boolean, reasonCode: AccessGraphGate["reasonCode"]) =>
    senderGate({
      isGroup: true,
      policy: params.policy.groupPolicy,
      allowlistSource: group,
      allowed,
      reasonCode,
    });
  if (params.policy.groupPolicy === "disabled") {
    return decide(false, "group_policy_disabled");
  }
  if (params.policy.groupPolicy === "open") {
    return decide(true, "group_policy_open");
  }
  if (!group.hasConfiguredEntries) {
    return decide(false, "group_policy_empty_allowlist");
  }
  if (group.match.matched) {
    return decide(true, "group_policy_allowed");
  }
  return decide(false, allowlistFailureReason(group) ?? "group_policy_not_allowlisted");
}

/**
 * Applies event auth mode to sender gates for non-message callbacks.
 */
export function applyEventAuthModeToSenderGate(params: {
  state: NormalizedIngressState;
  senderGate: AccessGraphGate;
}): AccessGraphGate {
  if (params.state.event.authMode === "inbound" || params.senderGate.allowed) {
    return params.senderGate;
  }
  // Non-inbound events can be authorized by command/origin/route gates, so a failed sender
  // gate becomes an ignored diagnostic instead of a dispatch block.
  const reasonCode = "sender_not_required";
  return {
    ...params.senderGate,
    effect: "ignore",
    allowed: true,
    reasonCode,
    allowlist: params.senderGate.allowlist
      ? { ...params.senderGate.allowlist, reasonCode }
      : undefined,
  };
}
