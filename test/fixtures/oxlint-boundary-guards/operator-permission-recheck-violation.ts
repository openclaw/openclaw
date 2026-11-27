import { resolveOperatorRolePolicy } from "../../../src/gateway/operator-role-policy.js";
import * as profiles from "../../../src/state/user-profile-list.js";

export function runTool(client: Parameters<typeof resolveOperatorRolePolicy>[0], cfg: never) {
  return async () => {
    profiles.captureResidentUserProfileAccess("profile").assertCurrent();
    // Lazy loading must not hide a reader from the rule.
    const { onOperatorRolePolicyChanged: subscribe } =
      await import("../../../src/gateway/operator-role-policy.js");
    subscribe(() => {});
  };
}
