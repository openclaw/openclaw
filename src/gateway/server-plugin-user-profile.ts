import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { withInProcessGatewayDispatch } from "./server-plugin-in-process-dispatch.js";
import { canTrustedOfficialPluginRequestScopes } from "./server-plugin-subagent-runtime.js";

export async function withTrustedPluginUserProfileIdentity<T>(
  params: { profileId: string; emails: readonly string[] },
  run: (assertCurrent: () => void) => Promise<T>,
  resolveGatewayContext?: GatewayContextResolver,
): Promise<T> {
  if (
    typeof params.profileId !== "string" ||
    !params.profileId ||
    params.profileId.length > 128 ||
    !Array.isArray(params.emails) ||
    params.emails.length > 500 ||
    params.emails.some((email) => typeof email !== "string" || !email || email.length > 254)
  ) {
    throw new Error("Profile identity requires a profileId and at most 500 canonical emails");
  }
  const scope = getPluginRuntimeGatewayRequestScope();
  if (!canTrustedOfficialPluginRequestScopes(scope ?? {})) {
    throw new Error("Profile identity is only available to bundled or trusted official plugins");
  }
  const profileId = params.profileId;
  const emails = [...new Set(params.emails)];
  return await withInProcessGatewayDispatch(
    "users.list",
    {},
    {
      forceSyntheticClient: true,
      pluginRuntimeOwnerId: scope?.pluginId,
      resolveGatewayContext,
      syntheticScopes: ["operator.read"],
      ...(!scope?.client ? { operatorRoleActor: { kind: "system" as const } } : {}),
    },
    async (resolved) => {
      const assertLifetime = () => {
        resolved.assertContextCurrent();
        resolved.assertInvocationCurrent();
        scope?.signal?.throwIfAborted();
        if (resolved.hasCurrentClientAuthority?.() === false) {
          throw new Error("Profile identity caller authority is no longer active");
        }
      };
      const { authorizeGatewayRequestPreDispatch, createRequestGatewayMethodRegistry } =
        await import("./server-methods.js");
      assertLifetime();
      const authorization = await authorizeGatewayRequestPreDispatch({
        method: "users.list",
        requestParams: {},
        client: resolved.client,
        context: resolved.context,
        methodRegistry:
          resolved.context.getGatewayMethodRegistry?.() ?? createRequestGatewayMethodRegistry(),
        hasCurrentClientAuthority: resolved.hasCurrentClientAuthority,
        assertInvocationCurrent: assertLifetime,
      });
      try {
        const assertCaller = () => {
          assertLifetime();
          if (authorization.error) {
            throw new Error(authorization.error.message);
          }
          authorization.sessionAccessAuthority?.assertCurrent();
          authorization.sessionMutationAuthorization?.assertCurrent();
        };
        assertCaller();
        const profile = await prepareUserProfileIdentity(profileId, {}, emails);
        try {
          assertCaller();
          const bindings = profile.emailBindingIds;
          const assertCurrent = () => {
            assertCaller();
            profile.readCurrentProfile(bindings);
          };
          assertCurrent();
          return await run(assertCurrent);
        } finally {
          profile.release();
        }
      } finally {
        authorization.sessionAccessAuthority?.release();
      }
    },
  );
}
