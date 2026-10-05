import type { GatewayReadSharing } from "./descriptor.js";

type ShareKey = GatewayReadSharing["shareKey"];

function callerKey(...[caller, params]: Parameters<ShareKey>): string | null {
  const { client } = caller;
  if (
    !client?.authenticatedUserProfile ||
    client.connect.role !== "operator" ||
    client.internal?.syntheticClient ||
    client.internal?.agentToolCaller ||
    client.internal?.agentRuntimeIdentity ||
    client.internal?.operatorRunAuthority ||
    client.internal?.pluginSubagentRequester ||
    client.internal?.nodeInvokeStream
  ) {
    return null;
  }
  return JSON.stringify(
    [
      client.authenticatedUserProfile.profileId,
      client.authenticatedUserId,
      client.internal?.operatorRoleActor,
      (client.connect.scopes ?? []).toSorted(),
      (client.connect.caps ?? []).toSorted(),
      client.connect.client.id,
      client.connect.client.mode,
      params,
    ],
    (_key, value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b)))
        : value,
  );
}

export const cronListShareKey: ShareKey = (caller, params) =>
  caller.read?.shareable === true ? callerKey(caller, params) : null;

export const sessionsListShareKey: ShareKey = (caller, params) => callerKey(caller, params);

export const modelsListShareKey: ShareKey = (caller, params) =>
  params.refresh === true ? null : callerKey(caller, params);

export const chatMetadataShareKey: ShareKey = (caller, params) => callerKey(caller, params);
