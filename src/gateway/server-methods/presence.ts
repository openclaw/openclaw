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
  type PresenceDevice,
  type PresenceLocation,
  type PresencePerson,
  type PresenceQueryParams,
  type PresenceQueryResult,
} from "../../../packages/gateway-protocol/src/schema/presence.js";
import type { PresenceEntry } from "../../../packages/gateway-protocol/src/schema/snapshot.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { groupPluginRecords as groupRecords } from "../../plugins/record-groups.js";
import { groupPresenceUsers, presenceUserKey } from "../../shared/presence-user.js";
import { buildAuthenticatedPresenceUser } from "../authenticated-presence-user.js";
import type { NodeSession } from "../node-session.types.js";
import { resolveGatewayOperatorRoleActor } from "../operator-role-policy.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayClient, GatewayRequestHandlers, GatewayRequestOptions } from "./types.js";
import { assertValidParams } from "./validation.js";

type Observation = {
  entry: PresenceEntry;
  connectionId: string;
  deviceId: string;
  node?: NodeSession;
  activity: PresenceDevice["activity"];
};

function deviceId(entry: PresenceEntry, connectionId: string): string {
  return entry.deviceId
    ? `device:${entry.deviceId}`
    : entry.instanceId
      ? `instance:${entry.user ? presenceUserKey(entry.user) : `connection:${connectionId}`}:${entry.instanceId}`
      : `connection:${connectionId}`;
}

function latestActivity(observations: readonly Observation[]): PresenceDevice["activity"] {
  return (
    observations
      .flatMap(({ activity }) => (activity ? [activity] : []))
      .toSorted((a, b) => b.at - a.at || a.deviceId.localeCompare(b.deviceId))[0] ?? null
  );
}

function collectObservations(entries: readonly PresenceEntry[], nodes: readonly NodeSession[]) {
  const observations = new Map<string, Observation>();
  const nodesByConnection = new Map(nodes.map((node) => [node.connId, node]));
  for (const entry of entries) {
    const connectionId = entry.connectionId;
    if (
      !connectionId ||
      entry.reason === "disconnect" ||
      (entry.roles?.includes("node") && !nodesByConnection.has(connectionId))
    ) {
      continue;
    }
    const id = deviceId(entry, connectionId);
    observations.set(connectionId, {
      entry,
      connectionId,
      deviceId: id,
      activity:
        entry.connectionLastActivityAt === undefined
          ? null
          : { at: entry.connectionLastActivityAt, source: "openclaw-interaction", deviceId: id },
    });
  }
  for (const node of nodes) {
    const existing = observations.get(node.connId);
    const user =
      node.client.authenticatedUserProfile?.profileId === GATEWAY_OWNER_PROFILE_ID ||
      (node.client.authenticatedGitHubIdentitySync && !node.client.authenticatedUserProfile)
        ? undefined
        : buildAuthenticatedPresenceUser(node.client);
    const entry: PresenceEntry = {
      ...existing?.entry,
      connectionId: node.connId,
      deviceId: node.client.connect.device?.id ?? node.nodeId,
      host: node.displayName ?? existing?.entry.host ?? node.nodeId,
      clientId: node.clientId,
      platform: node.platform,
      deviceFamily: node.deviceFamily,
      timeZone: node.client.connect.client.timeZone,
      ip: node.client.internal?.isLocalClient ? undefined : (existing?.entry.ip ?? node.remoteIp),
      user,
      ts: node.presenceUpdatedAtMs ?? node.connectedAtMs,
      onlineSince: existing?.entry.onlineSince ?? node.connectedAtMs,
    };
    const id = deviceId(entry, node.connId);
    const nativeActivity: PresenceDevice["activity"] =
      node.lastActiveAtMs !== undefined && node.presenceActivitySource
        ? {
            at: node.lastActiveAtMs,
            source: node.presenceActivitySource === "app" ? "app-input" : "system-input",
            deviceId: id,
          }
        : null;
    observations.set(node.connId, {
      entry,
      connectionId: node.connId,
      deviceId: id,
      node,
      activity:
        nativeActivity && nativeActivity.at > (existing?.activity?.at ?? -1)
          ? nativeActivity
          : (existing?.activity ?? null),
    });
  }
  return [...observations.values()];
}

function projectDevices(
  observations: readonly Observation[],
  include: NonNullable<PresenceQueryParams["include"]>,
  locations: ReadonlyMap<string, PresenceLocation>,
): PresenceDevice[] {
  const grouped = groupRecords(observations, (observation) => observation.deviceId);
  return [...grouped.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([id, group]) => {
      const node = group.find((item) => item.node)?.node;
      const names = group.flatMap(({ entry }) => (entry.host ? [entry.host] : [])).toSorted();
      const device: PresenceDevice = {
        id,
        name: node?.displayName ?? names[0] ?? id,
        kind: node ? "node" : "client",
        personIds: [
          ...new Set(
            group.flatMap(({ entry }) => (entry.user ? [presenceUserKey(entry.user)] : [])),
          ),
        ].toSorted(),
        online: true,
        activity: latestActivity(group),
        connections: group
          .toSorted((a, b) => a.connectionId.localeCompare(b.connectionId))
          .map(({ entry, connectionId }) => {
            const connection: PresenceDevice["connections"][number] = { id: connectionId };
            for (const field of ["clientId", "platform", "deviceFamily", "timeZone"] as const) {
              const value = entry[field];
              if (value) {
                connection[field] = value;
              }
            }
            if (include.includes("network")) {
              connection.network = { ip: entry.ip ?? null };
            }
            if (include.includes("location")) {
              connection.location = (entry.ip && locations.get(entry.ip)) || {
                source: "ip",
                status: "unavailable",
              };
            }
            return connection;
          }),
      };
      if (node) {
        device.nodeId = node.nodeId;
      }
      return device;
    });
}

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
    const summarize = (
      query: typeof params,
      resolvedLocations?: ReadonlyMap<string, PresenceLocation>,
    ): PresenceQueryResult => {
      const presence = context.getPresenceSnapshot();
      const nodes = context.nodeRegistry.listCurrentConnectedSync();
      const requestingKey = requesterKey(client);
      const observedAt = Date.now();
      const include = query.include ?? [];
      const locations = resolvedLocations ?? new Map<string, PresenceLocation>();
      const observations = collectObservations(presence, nodes);
      const groups = groupPresenceUsers(observations.map(({ entry }) => entry)).users;
      const people: PresencePerson[] = groups
        .map((group): PresencePerson => {
          const id = presenceUserKey(group);
          const own = observations.filter(
            ({ entry }) => entry.user && presenceUserKey(entry.user) === id,
          );
          const onlineSince = own.flatMap(({ entry }) =>
            entry.onlineSince === undefined ? [] : [entry.onlineSince],
          );
          const devices = projectDevices(own, include, locations);
          const person: PresencePerson = {
            id,
            name:
              group.identity?.id === GATEWAY_OWNER_PROFILE_ID
                ? "Shared owner"
                : (group.name ?? group.email ?? group.id),
            online: true,
            activity: latestActivity(own),
            deviceCount: devices.length,
          };
          if (group.identity) {
            person.profileId = group.identity.id;
          }
          if (onlineSince.length) {
            person.onlineSince = Math.min(...onlineSince);
          }
          if (include.length) {
            person.devices = devices;
          }
          return person;
        })
        .toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      const base: PresenceQueryResult = {
        observedAt,
        status: "ok",
        people: [],
        totalPeople: 0,
        truncated: false,
      };
      const sharedDevices = () =>
        projectDevices(
          observations.filter(({ entry }) => !entry.user),
          include,
          locations,
        );
      if (action === "device") {
        const devices = projectDevices(observations, include, locations).filter(
          (device) => device.id === query.deviceId,
        );
        return {
          ...base,
          status: devices.length ? "ok" : "not-found",
          devices,
          ...(devices.length
            ? {}
            : { message: "No connected device matches that presence device ID." }),
        };
      }
      let matches = people;
      if (action === "person") {
        const selector = query.person?.trim() ?? "";
        if (selector.toLowerCase() === "me") {
          if (!requestingKey) {
            return {
              ...base,
              status: "identity-unavailable",
              message:
                "This caller has no authenticated person identity. Select a person returned by list.",
            };
          }
          matches = people.filter((person) => person.id === requestingKey);
        } else {
          const exact = people.filter(
            (person) => person.id === selector || person.profileId === selector,
          );
          matches = exact.length
            ? exact
            : people.filter((person) => person.name.toLowerCase() === selector.toLowerCase());
        }
        if (matches.length === 0) {
          return {
            ...base,
            status: "not-found",
            message: "No connected person matches. Offline activity is not retained.",
            ...(selector.toLowerCase() === "me" && include.length
              ? { devices: sharedDevices() }
              : {}),
          };
        }
      }
      const limit = query.limit ?? 50;
      return {
        ...base,
        status: action === "person" && matches.length > 1 ? "ambiguous" : "ok",
        people: matches.slice(0, limit),
        totalPeople: matches.length,
        truncated: matches.length > limit,
        ...(action === "person" && matches.length > 1
          ? { message: "Multiple connected people match. Select one of the returned person IDs." }
          : {}),
        ...((action === "list" ||
          (action === "person" && query.person?.trim().toLowerCase() === "me")) &&
        include.length
          ? {
              devices: sharedDevices(),
            }
          : {}),
      };
    };
    const locations = params.include?.includes("location")
      ? await lookupLocations(
          summarize({
            ...params,
            include: [...new Set([...(params.include ?? []), "network" as const])],
          }),
          options,
        )
      : undefined;
    readGatewayRequestMutationAuthority(options).assertCurrent();
    // Optional enrichment yields. Re-read live observations so disconnects and
    // identity changes during a database lookup cannot survive in the response.
    respond(true, summarize(params, locations), undefined);
  },
};
