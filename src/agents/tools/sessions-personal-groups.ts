import { isDeepStrictEqual } from "node:util";
import { UI_PERSONAL_SESSION_GROUPS_PREFERENCE_KEY as PERSONAL_GROUPS_KEY } from "../../../packages/gateway-protocol/src/schema/ui-navigation-preferences.js";
import type {
  UsersPrefsGetResult,
  UsersPrefsSetResult,
} from "../../../packages/gateway-protocol/src/schema/users.js";
import { normalizePersonalSessionGroups } from "../../shared/personal-session-groups.js";
import { jsonResult, ToolAuthorizationError, ToolInputError } from "./common.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";

function authoredGroups(value: unknown) {
  const groups = normalizePersonalSessionGroups(value);
  if (!groups || !isDeepStrictEqual(groups, value)) {
    throw new ToolInputError(
      "Personal groups require unique IDs, bounded labels and session references within the existing preference limits; no layout was truncated or saved.",
    );
  }
  return groups;
}

/** Use the same current-person, single-participant preference owner as the sidebar. */
export async function runPersonalSessionGroups(
  action: "personal_group_list" | "personal_group_set",
  params: Record<string, unknown>,
  request: AgentToolGatewayRequestCaller,
  signal?: AbortSignal,
) {
  const fields =
    action === "personal_group_list"
      ? ["action", "user"]
      : ["action", "user", "groups", "expectedGroups"];
  if (Object.keys(params).some((key) => !fields.includes(key))) {
    throw new ToolInputError(
      "Personal group actions accept only the current person's groups, never profile, session or shared-catalog selectors.",
    );
  }
  if (action === "personal_group_list") {
    const result = await request<UsersPrefsGetResult>({
      method: "users.prefs.get",
      params: { keys: [PERSONAL_GROUPS_KEY] },
      signal,
    });
    if (result.status !== "ok") {
      throw new ToolAuthorizationError(
        "Personal groups need a durable signed-in profile in your own Control UI turn.",
      );
    }
    const saved = result.entries[PERSONAL_GROUPS_KEY];
    return jsonResult({
      status: "ok",
      groups: saved === undefined ? [] : authoredGroups(saved),
      expectedGroups: saved ?? null,
    });
  }
  const groups = authoredGroups(params.groups);
  if (!Object.hasOwn(params, "expectedGroups")) {
    throw new ToolInputError(
      "Read personal_group_list first and supply its exact expectedGroups before replacing the ordered personal layout.",
    );
  }
  const expected = params.expectedGroups === null ? null : authoredGroups(params.expectedGroups);
  const result = await request<UsersPrefsSetResult>({
    method: "users.prefs.set",
    params: {
      entries: { [PERSONAL_GROUPS_KEY]: groups },
      expectedEntries: { [PERSONAL_GROUPS_KEY]: expected },
    },
    signal,
  });
  if (result.status === "no_durable_identity") {
    throw new ToolAuthorizationError(
      "Personal groups need a durable signed-in profile in your own Control UI turn.",
    );
  }
  return jsonResult(result.status === "ok" ? { status: "ok", groups } : result);
}
