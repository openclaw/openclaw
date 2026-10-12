import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { withInProcessGatewayRead } from "./server-plugin-in-process-dispatch.js";
import { canTrustedOfficialPluginRequestScopes } from "./server-plugin-subagent-runtime.js";

export async function withTrustedPluginUserProfileIdentity<T>(
  params: { profileId: string; emails: readonly string[]; githubAccountIds?: readonly number[] },
  run: (assertCurrent: () => void) => Promise<T>,
  resolveGatewayContext?: GatewayContextResolver,
): Promise<T> {
  if (
    typeof params.profileId !== "string" ||
    !params.profileId ||
    params.profileId.length > 128 ||
    !Array.isArray(params.emails) ||
    params.emails.length > 500 ||
    params.emails.some((email) => typeof email !== "string" || !email || email.length > 254) ||
    (params.githubAccountIds !== undefined &&
      (!Array.isArray(params.githubAccountIds) ||
        params.githubAccountIds.length > 500 ||
        params.githubAccountIds.some(
          (accountId) => !Number.isSafeInteger(accountId) || accountId <= 0,
        )))
  ) {
    throw new Error(
      "Profile identity requires a profileId and at most 500 canonical emails or verified GitHub account IDs",
    );
  }
  const scope = getPluginRuntimeGatewayRequestScope();
  if (!canTrustedOfficialPluginRequestScopes(scope ?? {})) {
    throw new Error("Profile identity is only available to bundled or trusted official plugins");
  }
  const profileId = params.profileId;
  const emails = [...new Set(params.emails)];
  const githubAccountIds = params.githubAccountIds && [...new Set(params.githubAccountIds)];
  return await withInProcessGatewayRead(
    {
      method: "users.list",
      scope,
      resolveGatewayContext,
      callerAuthorityError: "Profile identity caller authority is no longer active",
    },
    async (_resolved, assertCaller) => {
      const profile = await prepareUserProfileIdentity(profileId, {}, emails);
      try {
        assertCaller();
        const bindings = profile.emailBindingIds;
        const assertCurrent = () => {
          assertCaller();
          profile.readCurrentProfile(bindings, githubAccountIds);
        };
        assertCurrent();
        return await run(assertCurrent);
      } finally {
        profile.release();
      }
    },
  );
}
