import type { UsersListResult } from "../../../packages/gateway-protocol/src/index.js";
import { jsonResult, readNonNegativeIntegerParam } from "./common.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";

export async function listSessionOwnerProfiles(
  params: Record<string, unknown>,
  request: AgentToolGatewayRequestCaller,
) {
  const offset = readNonNegativeIntegerParam(params, "offset") ?? 0;
  const directory = await request<UsersListResult>({
    method: "users.list",
    params:
      params.githubAccountIds !== undefined ? { githubAccountIds: params.githubAccountIds } : {},
  });
  const selected =
    params.githubAccountIds === undefined
      ? undefined
      : new Set(directory.githubProfiles?.map(({ profileId }) => profileId));
  const profiles = directory.profiles.filter(
    (profile) => !profile.mergedInto && (!selected || selected.has(profile.id)),
  );
  const page = profiles.slice(offset, offset + 32).map(({ id, displayName, githubIdentity }) => ({
    id,
    displayName,
    githubIdentity,
  }));
  const pageIds = new Set(page.map(({ id }) => id));
  return jsonResult({
    profiles: page,
    ...(directory.githubProfiles
      ? {
          githubProfiles: directory.githubProfiles.filter(({ profileId }) =>
            pageIds.has(profileId),
          ),
        }
      : {}),
    ...(offset + page.length < profiles.length ? { nextOffset: offset + page.length } : {}),
  });
}
