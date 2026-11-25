import { isIncognitoSessionKey } from "../../../../src/shared/incognito-session-key.js";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../../src/shared/session-list-limits.js";
import type { SessionsListResult } from "../../api/types.ts";
import type { SessionGroupSettings } from "./custom-groups.ts";

export type BootRoster = {
  agentId: string | null;
  groups: readonly string[];
  groupSettings: readonly SessionGroupSettings[];
  sectionOrder: readonly string[];
  result: SessionsListResult;
};

export function captureBootRoster(
  state: Omit<BootRoster, "result"> & {
    result: SessionsListResult | null;
    resultCached?: boolean;
    loading: boolean;
    error: string | null;
  },
): BootRoster | null {
  if (!state.result || state.resultCached || state.loading || state.error) {
    return null;
  }
  // The lazy sidebar snapshot boundary validates and strips fields before persistence.
  return {
    agentId: state.agentId,
    groups: state.groups,
    groupSettings: state.groupSettings,
    sectionOrder: state.sectionOrder,
    result: {
      ...state.result,
      sessions: state.result.sessions
        .filter((session) => !session.incognito && !isIncognitoSessionKey(session.key))
        .slice(0, SIDEBAR_SESSION_ROSTER_LIMIT)
        .map(({ incognito: _incognito, ...session }) => session),
    },
  };
}
