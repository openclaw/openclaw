import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { prepareUserProfileRoleAuthority } from "../state/user-channel-identity-operations.js";
import type { GatewayClient } from "./server-methods/types.js";
import {
  hasTelegramLegacyDirectAccess,
  prepareTelegramLinkedDirectReads,
  resolveTelegramSessionDirect,
} from "./session-channel-direct-read.js";
import { resolveTelegramSessionGroup } from "./session-channel-group.js";
import {
  prepareTelegramGroupMembership,
  prepareTelegramGroupMemberships,
  type TelegramGroupMembership,
} from "./session-channel-membership.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { isGatewayAdmin } from "./session-sharing-policy.js";

type Group = { accountId: string; groupId: string };
type GroupRead = {
  group: Group;
  fact?: TelegramGroupMembership;
  checkedAt: number;
  pending?: Promise<void>;
};
type Binding = {
  cfg: OpenClawConfig;
  runtimeConfig: OpenClawConfig;
  current: () => boolean;
  groups: Map<string, GroupRead>;
  direct?: Awaited<ReturnType<typeof prepareTelegramLinkedDirectReads>>;
  revision: number;
  timer?: ReturnType<typeof setTimeout>;
  stop: () => void;
};
const bindings = new WeakMap<GatewayClient, Binding>();
const FRESH_MS = 60_000;
const REFRESH_MS = 30_000;
const groupKey = (group: Group) => JSON.stringify([group.accountId, group.groupId]);

function currentBinding(client: GatewayClient | null, cfg: OpenClawConfig) {
  const binding = client && bindings.get(client);
  return binding && (binding.cfg === cfg || binding.runtimeConfig === cfg) && binding.current()
    ? binding
    : undefined;
}

export function readTelegramSessionMembership(
  client: GatewayClient | null,
  cfg: OpenClawConfig,
  key: string,
  entry: Parameters<typeof resolveTelegramSessionGroup>[1],
): boolean {
  const binding = currentBinding(client, cfg);
  if (binding?.direct?.canRead(key, entry)) {
    return true;
  }
  const group = resolveTelegramSessionGroup(key, entry);
  const read = group && binding?.groups.get(groupKey(group));
  return Boolean(read?.fact && Date.now() - read.checkedAt < FRESH_MS && read.fact.isCurrent());
}

/** Expiry, unlink, and a refreshed negative result invalidate retained visible rows. */
export function telegramSessionMembershipKey(client: GatewayClient | null, cfg: OpenClawConfig) {
  const binding = currentBinding(client, cfg);
  if (!binding) {
    return "";
  }
  const now = Date.now();
  return JSON.stringify([
    binding.revision,
    binding.direct?.revisionKey(),
    [...binding.groups].map(([key, read]) => [
      key,
      Boolean(read.fact && now - read.checkedAt < FRESH_MS && read.fact.isCurrent()),
    ]),
  ]);
}

/** Connection-owned reads survive an RPC/model turn; disconnect ends refresh work. */
export async function prepareTelegramSessionReads(params: {
  client: GatewayClient | null;
  cfg: OpenClawConfig;
  runtimeConfig?: OpenClawConfig;
  getConfig: () => OpenClawConfig;
  groups: readonly Group[];
}): Promise<void> {
  const { client, cfg, getConfig } = params;
  const profileId = client?.authenticatedUserProfile?.profileId;
  if (
    !client ||
    !profileId ||
    client.internal?.agentToolCaller ||
    client.internal?.agentRuntimeIdentity
  ) {
    return;
  }
  let binding = currentBinding(client, cfg);
  if (!binding) {
    bindings.get(client)?.stop();
    const authority = await prepareUserProfileRoleAuthority(profileId, {
      signal: client.connectionSignal,
    });
    if (!authority || authority.profileId !== profileId) {
      return;
    }
    // Another request on this connection may have prepared the same owner while we awaited.
    binding = currentBinding(client, cfg);
    if (!binding) {
      let active = true;
      const current = () =>
        active &&
        !client.invalidated &&
        !client.connectionSignal?.aborted &&
        client.authenticatedUserProfile?.profileId === profileId &&
        getConfig() === cfg &&
        authority.isCurrent();
      if (!current()) {
        return;
      }
      const next: Binding = {
        cfg,
        runtimeConfig: params.runtimeConfig ?? cfg,
        current,
        groups: new Map(),
        revision: 0,
        stop: () => {
          active = false;
          clearTimeout(next.timer);
          next.groups.clear();
          client.connectionSignal?.removeEventListener("abort", next.stop);
          if (bindings.get(client) === next) {
            bindings.delete(client);
          }
        },
      };
      binding = next;
      bindings.set(client, binding);
      client.connectionSignal?.addEventListener("abort", binding.stop, { once: true });
    }
  }
  if (params.runtimeConfig && binding.runtimeConfig !== params.runtimeConfig) {
    // Credentials or adapter policy changed: old facts cannot authorize the new runtime.
    binding.groups.clear();
    binding.direct = undefined;
    binding.revision++;
    binding.runtimeConfig = params.runtimeConfig;
  }
  const owner = binding;
  const directRuntimeConfig = owner.runtimeConfig;
  const direct = prepareTelegramLinkedDirectReads({
    profileId,
    signal: client.connectionSignal,
    qualifyAccount: (_key, route) => {
      // The owner grants the complete legacy conversation explicitly. This does
      // not infer historical ownership from the last route or activate a global ACL.
      return hasTelegramLegacyDirectAccess(cfg, profileId, route);
    },
  }).then((facts) => {
    if (owner.current() && owner.runtimeConfig === directRuntimeConfig) {
      owner.direct = facts;
      owner.revision++;
    }
  });
  const refresh = async (groups: readonly Group[], force = false) => {
    const selected = [...new Map(groups.map((group) => [groupKey(group), group])).values()].map(
      (group) => {
        const key = groupKey(group);
        let read = owner.groups.get(key);
        if (!read) {
          read = { group, checkedAt: 0 };
          owner.groups.set(key, read);
        }
        return read;
      },
    );
    const idle = selected.filter(
      (read) =>
        !read.pending &&
        (force || !read.fact?.isCurrent() || Date.now() - read.checkedAt >= FRESH_MS),
    );
    if (idle.length) {
      const batch = prepareTelegramGroupMemberships({
        cfg: owner.runtimeConfig,
        profileId,
        groups: idle.map((read) => read.group),
        signal: client.connectionSignal,
      });
      for (const read of idle) {
        read.pending = batch
          .then((facts) => {
            if (owner.current()) {
              read.fact = facts.get(groupKey(read.group));
              read.checkedAt = Date.now();
              owner.revision++;
            }
          })
          .finally(() => {
            read.pending = undefined;
          });
      }
    }
    await Promise.all(selected.flatMap((read) => (read.pending ? [read.pending] : [])));
  };
  const schedule = () => {
    if (
      !client.connectionSignal ||
      owner.timer ||
      !owner.current() ||
      ![...owner.groups.values()].some((read) => read.fact?.isCurrent())
    ) {
      return;
    }
    owner.timer = runInDetachedAsyncContext(() =>
      setTimeout(() => {
        owner.timer = undefined;
        if (!owner.current()) {
          owner.stop();
          return;
        }
        const groups = [...owner.groups.values()]
          .filter((read) => read.fact?.isCurrent())
          .map((read) => read.group);
        void refresh(groups, true).then(schedule, () => owner.stop());
      }, REFRESH_MS),
    );
    owner.timer.unref();
  };
  try {
    await Promise.all([refresh(params.groups), direct]);
    schedule();
  } catch {
    owner.stop();
  }
}

/** Prepare one HTTP request's channel fact without creating a connection owner. */
export async function prepareTelegramSessionEntryRead(params: {
  cfg: OpenClawConfig;
  getConfig: () => OpenClawConfig;
  profileId: string;
  key: string;
  entry: Parameters<typeof resolveTelegramSessionGroup>[1];
  signal?: AbortSignal;
}): Promise<(key: string, entry: Parameters<typeof resolveTelegramSessionGroup>[1]) => boolean> {
  const { cfg, getConfig, profileId, key, entry, signal } = params;
  const group = resolveTelegramSessionGroup(key, entry);
  if (group) {
    const fact = await prepareTelegramGroupMembership({ cfg, profileId, ...group, signal });
    const checkedAt = Date.now();
    return (currentKey, currentEntry) => {
      const current = resolveTelegramSessionGroup(currentKey, currentEntry);
      return Boolean(
        getConfig() === cfg &&
        currentKey === key &&
        current?.accountId === group.accountId &&
        current.groupId === group.groupId &&
        Date.now() - checkedAt < FRESH_MS &&
        fact?.isCurrent(),
      );
    };
  }
  if (resolveTelegramSessionDirect(key, entry)) {
    const direct = await prepareTelegramLinkedDirectReads({
      profileId,
      signal,
      qualifyAccount: (_key, route) => hasTelegramLegacyDirectAccess(getConfig(), profileId, route),
    });
    return (currentKey, currentEntry) =>
      getConfig() === cfg && currentKey === key && direct.canRead(currentKey, currentEntry);
  }
  return () => false;
}

/** Lists discover trusted existing group routes; membership never enumerates private sessions. */
export async function prepareTelegramSessionListMembership(
  projection: SessionRowProjection,
  client: GatewayClient | null,
) {
  if (!client || isGatewayAdmin(client)) {
    return undefined;
  }
  const groups = projection.selectEntries({ sortBy: null }, true).flatMap((row) => {
    const group = row.entry && resolveTelegramSessionGroup(row.key, row.entry);
    return group ? [group] : [];
  });
  await prepareTelegramSessionReads({
    client,
    cfg: projection.getPolicyConfig(),
    runtimeConfig: projection.state.cfg,
    getConfig: () => projection.getPolicyConfig(),
    groups,
  });
  return (key: string, entry: Parameters<typeof resolveTelegramSessionGroup>[1]) =>
    readTelegramSessionMembership(client, projection.getPolicyConfig(), key, entry);
}
