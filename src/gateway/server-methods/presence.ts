import { isIP } from "node:net";
import { Type } from "typebox";
import { lazyCompile } from "../../../packages/gateway-protocol/src/protocol-validator.js";
import { closedObject } from "../../../packages/gateway-protocol/src/schema/closed-object.js";
import {
  ErrorCodes,
  errorShape,
} from "../../../packages/gateway-protocol/src/schema/error-codes.js";
import {
  PresenceLocationSchema,
  PresenceQueryParamsSchema,
  type PresenceLocation,
  type PresenceQueryResult,
} from "../../../packages/gateway-protocol/src/schema/presence.js";
import { presenceUserKey } from "../../shared/presence-user.js";
import { resolveGatewayOperatorRoleActor } from "../operator-role-policy.js";
import { buildPresenceSummary } from "../presence-summary.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayClient, GatewayRequestHandlers, GatewayRequestOptions } from "./types.js";
import { assertValidParams } from "./validation.js";

const validateParams = lazyCompile(PresenceQueryParamsSchema);
const validateLocationResult = lazyCompile(
  closedObject({
    results: Type.Array(
      closedObject({
        ip: Type.String(),
        ...Type.Omit(PresenceLocationSchema, ["source"]).properties,
      }),
      { maxItems: 200 },
    ),
  }),
);

function requesterKey(client: GatewayClient | null): string | undefined {
  const actor = resolveGatewayOperatorRoleActor(client);
  if (actor) {
    return actor.kind === "operator" ? `profile:${actor.profileId}` : undefined;
  }
  const profile = client?.authenticatedUserProfile;
  if (profile) {
    return `profile:${profile.profileId}`;
  }
  return client?.authenticatedUserId && !client.authenticatedGitHubIdentitySync
    ? presenceUserKey({ id: client.authenticatedUserId })
    : undefined;
}

async function lookupLocations(
  summary: PresenceQueryResult,
  options: GatewayRequestOptions,
): Promise<ReadonlyMap<string, PresenceLocation>> {
  const devices = [
    ...summary.people.flatMap((person) => person.devices ?? []),
    ...(summary.devices ?? []),
  ];
  const ips = [
    ...new Set(
      devices.flatMap((device) =>
        device.connections.flatMap((connection) => {
          const ip = connection.network?.ip;
          return ip && isIP(ip) ? [ip] : [];
        }),
      ),
    ),
  ];
  const locations = new Map<string, PresenceLocation>();
  if (!ips.length) {
    return locations;
  }
  const { dispatchGatewayMethodInProcessRaw } =
    await import("../server-plugin-in-process-dispatch.js");
  for (let offset = 0; offset < ips.length; offset += 200) {
    const result = await dispatchGatewayMethodInProcessRaw(
      "geolocation.lookup",
      { ips: ips.slice(offset, offset + 200) },
      {
        disableSyntheticClient: true,
        requireScopedClient: true,
        signal: options.signal,
        hasCurrentClientAuthority: options.hasCurrentClientAuthority,
        sessionMutationCommitGuard: () =>
          readGatewayRequestMutationAuthority(options).assertCurrent(),
      },
    );
    readGatewayRequestMutationAuthority(options).assertCurrent();
    if (result.ok && validateLocationResult(result.payload)) {
      for (const { ip, ...location } of result.payload.results) {
        locations.set(ip, { source: "ip", ...location });
      }
    }
  }
  return locations;
}

export const presenceHandlers: GatewayRequestHandlers = {
  "presence.query": async (options) => {
    const { params, respond, context, client } = options;
    if (!assertValidParams(params, validateParams, "presence.query", respond)) {
      return;
    }
    const action = params.action ?? "list";
    if (
      (action === "person" && !params.person?.trim()) ||
      (action === "device" && !params.deviceId?.trim()) ||
      (action !== "person" && params.person !== undefined) ||
      (action !== "device" && params.deviceId !== undefined)
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "person requires a person selector; device requires a presence deviceId. Selectors apply only to their matching action.",
        ),
      );
      return;
    }
    const locations = params.include?.includes("location")
      ? await lookupLocations(
          buildPresenceSummary({
            params: {
              ...params,
              include: [...new Set([...(params.include ?? []), "network" as const])],
            },
            presence: context.getPresenceSnapshot(),
            nodes: context.nodeRegistry.listCurrentConnectedSync(),
            requesterKey: requesterKey(client),
            observedAt: Date.now(),
          }),
          options,
        )
      : undefined;
    readGatewayRequestMutationAuthority(options).assertCurrent();
    // Optional enrichment yields. Re-read live observations so disconnects and
    // identity changes during a database lookup cannot survive in the response.
    respond(
      true,
      buildPresenceSummary({
        params,
        presence: context.getPresenceSnapshot(),
        nodes: context.nodeRegistry.listCurrentConnectedSync(),
        requesterKey: requesterKey(client),
        observedAt: Date.now(),
        locations,
      }),
      undefined,
    );
  },
};
