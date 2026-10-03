import type { AuthenticatedUser } from "../app/user-profile.ts";

export type ControlUiMockPresenceUser = {
  self?: boolean;
  id: string;
  identity?: AuthenticatedUser["identity"];
  name?: string;
  email?: string;
  avatarUrl?: string;
  deviceFamily?: string;
  host?: string;
  ip?: string;
  instanceId?: string;
  lastInputSeconds?: number;
  onlineSince?: number;
  lastActivityAt?: number;
  timeZone?: string;
  mode?: string;
  platform?: string;
  ts?: number;
  watchedSessions?: string[];
};

// Serialized into the browser with explicit runtime dependencies.
export function createControlUiMockPresence(
  scenario: { presenceUsers: ControlUiMockPresenceUser[] },
  isRecord: (value: unknown) => value is Record<string, unknown>,
) {
  /** Presence slice of the connect snapshot. The self-flagged entry adopts the
   * connecting client's instanceId so presence surfaces resolve "you". */
  function snapshot(connectParams: unknown): { presence?: unknown[] } {
    if (scenario.presenceUsers.length === 0) {
      return {};
    }
    const client = isRecord(connectParams) ? connectParams.client : undefined;
    const selfInstanceId =
      isRecord(client) && typeof client.instanceId === "string"
        ? client.instanceId
        : "e2e-self-instance";
    return {
      presence: scenario.presenceUsers.map((user, index) => ({
        instanceId: user.self ? selfInstanceId : (user.instanceId ?? `e2e-presence-${index}`),
        mode: user.mode ?? "webchat",
        reason: "connect",
        ts: user.ts ?? Date.now(),
        ...(user.host ? { host: user.host } : {}),
        ...(user.ip ? { ip: user.ip } : {}),
        ...(user.platform ? { platform: user.platform } : {}),
        ...(user.deviceFamily ? { deviceFamily: user.deviceFamily } : {}),
        ...(user.lastInputSeconds === undefined ? {} : { lastInputSeconds: user.lastInputSeconds }),
        ...(user.onlineSince === undefined ? {} : { onlineSince: user.onlineSince }),
        ...(user.lastActivityAt === undefined ? {} : { lastActivityAt: user.lastActivityAt }),
        ...(user.timeZone ? { timeZone: user.timeZone } : {}),
        user: {
          id: user.id,
          ...(user.identity ? { identity: user.identity } : {}),
          name: user.name ?? null,
          email: user.email ?? null,
          avatarUrl: user.avatarUrl ?? null,
        },
        watchedSessions: user.watchedSessions ?? [],
      })),
    };
  }

  const self = scenario.presenceUsers.find((user) => user.self);
  return {
    snapshot,
    actor: { type: "human" as const, id: self?.id ?? "profile-1", label: self?.name ?? "You" },
  };
}
