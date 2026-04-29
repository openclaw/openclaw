import { buildScopedGroupIdCandidates, resolveTrustedGroupId } from "../agents/pi-tools.policy.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { loadSessionEntry } from "./session-utils.js";

export type TrustedGatewayToolGroupContext = {
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  trustGroupContext?: boolean;
  verifiedGroupIds?: readonly string[];
};

export function resolveTrustedGatewayToolGroupContext(
  sessionKey: string,
): TrustedGatewayToolGroupContext {
  try {
    const loaded = loadSessionEntry(sessionKey);
    const groupId = normalizeOptionalString(loaded.entry?.groupId);
    if (!groupId) {
      return {};
    }
    const verifiedGroupIds = buildScopedGroupIdCandidates(groupId);
    const trustedGroup = resolveTrustedGroupId({
      groupId,
      verifiedGroupIds,
      trustGroupContext: true,
    });
    if (trustedGroup.dropped) {
      return {};
    }
    return {
      groupId,
      groupChannel: loaded.entry?.groupChannel,
      groupSpace: loaded.entry?.space,
      trustGroupContext: true,
      verifiedGroupIds,
    };
  } catch {
    return {};
  }
}
