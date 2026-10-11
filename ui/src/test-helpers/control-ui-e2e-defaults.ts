import type { UserProfile } from "../../../packages/gateway-protocol/src/index.ts";
import { BUILTIN_THEMES } from "../../../packages/gateway-protocol/src/theme.js";
import type { ChannelsPairingListResult, ChannelsStatusSnapshot } from "../api/types.ts";
import type { ControlUiMockPresenceUser } from "./control-ui-e2e-contract.ts";

export const defaultControlUiFeatureMethods = [
  "chat.abort",
  "chat.history",
  "chat.send",
  "chat.metadata",
  "chat.startup",
  "config.apply",
  "config.patch",
  "config.schema",
  "config.set",
  "device.scopes.requestUpgrade",
  "device.scopes.waitUpgrade",
  "session.members.add",
  "session.members.list",
  "session.members.listEvidence",
  "session.members.remove",
  "session.reactions.list",
  "session.reactions.set",
  "session.visibility.set",
  "sessions.abort",
  "sessions.patchMany",
  "sessions.branches.switch",
  "sessions.compact",
  "sessions.create",
  "sessions.delete",
  "sessions.dispatch",
  "sessions.fork",
  "sessions.groups.delete",
  "sessions.groups.defaults",
  "sessions.groups.list",
  "sessions.groups.put",
  "sessions.groups.rename",
  "sessions.groups.update",
  "sessions.patch",
  "sessions.reclaim",
  "sessions.reset",
  "sessions.rewind",
  "sessions.search",
  "system.info",
  "users.github.status",
  "users.github.authorize.start",
  "users.github.authorize.poll",
  "users.github.authorize.cancel",
  "users.github.disconnect",
  "sessions.github.options",
  "sessions.github.status",
  "sessions.github.confirm",
  "themes.list",
  "themes.get",
  "themes.set",
  "themes.import",
  "tools.github.status",
  "tools.github.configure",
  "tools.github.authorize.start",
  "tools.github.authorize.poll",
  "tools.github.authorize.cancel",
  "update.hold",
  "update.run",
  "update.runs.get",
  "update.runs.list",
  "update.status",
  "worktrees.branches",
] as const;

export function createControlUiDefaultResponses(scenario: {
  presenceUsers?: ControlUiMockPresenceUser[];
}) {
  const user = scenario.presenceUsers?.find((entry) => entry.self);
  const profile: UserProfile | null = user
    ? {
        id: user.id,
        displayName: user.name ?? null,
        emails: user.email ? [user.email] : [],
        avatarMime: null,
        hasAvatar: Boolean(user.avatarUrl),
        githubIdentity: null,
        mergedInto: null,
        createdAt: 1,
        updatedAt: 1,
      }
    : null;
  const selection = {
    theme: BUILTIN_THEMES[0],
    current: { id: "claw", mode: "system", scope: "gateway", overrides: {} },
  };
  return {
    "channels.status": {
      ts: 0,
      channelOrder: [],
      channelLabels: {},
      channels: {},
      channelAccounts: {},
      channelDefaultAccountId: {},
    } satisfies ChannelsStatusSnapshot,
    "channels.pairing.list": {
      accounts: [],
      requests: [],
      commandOwnerConfigured: true,
      limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
    } satisfies ChannelsPairingListResult,
    "users.self": profile
      ? { profile }
      : {
          __mockError: { code: "FORBIDDEN", message: "users.self requires an authenticated user" },
        },
    "themes.list": { ...selection, themes: BUILTIN_THEMES },
    "themes.get": selection,
  };
}
