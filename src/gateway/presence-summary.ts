import type {
  PresenceDevice,
  PresenceLocation,
  PresencePerson,
  PresenceQueryParams,
  PresenceQueryResult,
} from "../../packages/gateway-protocol/src/schema/presence.js";
import type { PresenceEntry } from "../../packages/gateway-protocol/src/schema/snapshot.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { groupPresenceUsers, presenceUserKey } from "../shared/presence-user.js";
import { buildAuthenticatedPresenceUser } from "./authenticated-presence-user.js";
import type { NodeSession } from "./node-session.types.js";

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
  const grouped = new Map<string, Observation[]>();
  for (const observation of observations) {
    const group = grouped.get(observation.deviceId);
    if (group) {
      group.push(observation);
    } else {
      grouped.set(observation.deviceId, [observation]);
    }
  }
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
            if (entry.clientId) {
              connection.clientId = entry.clientId;
            }
            if (entry.platform) {
              connection.platform = entry.platform;
            }
            if (entry.deviceFamily) {
              connection.deviceFamily = entry.deviceFamily;
            }
            if (entry.timeZone) {
              connection.timeZone = entry.timeZone;
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

/** Read model shared by Gateway presence consumers; it retains no history or inferred ownership. */
export function buildPresenceSummary(options: {
  params: PresenceQueryParams;
  presence: readonly PresenceEntry[];
  nodes: readonly NodeSession[];
  requesterKey?: string;
  observedAt: number;
  locations?: ReadonlyMap<string, PresenceLocation>;
}): PresenceQueryResult {
  const { params, observedAt } = options;
  const include = params.include ?? [];
  const locations = options.locations ?? new Map<string, PresenceLocation>();
  const observations = collectObservations(options.presence, options.nodes);
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
  const action = params.action ?? "list";
  const sharedDevices = () =>
    projectDevices(
      observations.filter(({ entry }) => !entry.user),
      include,
      locations,
    );
  if (action === "device") {
    const devices = projectDevices(observations, include, locations).filter(
      (device) => device.id === params.deviceId,
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
    const selector = params.person?.trim() ?? "";
    if (selector.toLowerCase() === "me") {
      if (!options.requesterKey) {
        return {
          ...base,
          status: "identity-unavailable",
          message:
            "This caller has no authenticated person identity. Select a person returned by list.",
        };
      }
      matches = people.filter((person) => person.id === options.requesterKey);
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
        ...(selector.toLowerCase() === "me" && include.length ? { devices: sharedDevices() } : {}),
      };
    }
  }
  const limit = params.limit ?? 50;
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
      (action === "person" && params.person?.trim().toLowerCase() === "me")) &&
    include.length
      ? {
          devices: sharedDevices(),
        }
      : {}),
  };
}
