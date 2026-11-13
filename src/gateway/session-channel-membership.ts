import { resolveChannelPluginRegistration } from "../channels/plugins/registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { defaultRuntime } from "../runtime.js";
import {
  listCanonicalUserChannelIdentities,
  prepareUserChannelIdentityAuthority,
} from "../state/user-channel-identity-operations.js";

export type TelegramGroupMembership = { isCurrent: () => boolean };

/** Prepare a single live membership fact for synchronous read publication. */
export async function prepareTelegramGroupMembership(params: {
  cfg: OpenClawConfig;
  profileId: string;
  accountId: string;
  groupId: string;
  signal?: AbortSignal;
}): Promise<TelegramGroupMembership | undefined> {
  const signal = params.signal ?? AbortSignal.timeout(5_000);
  try {
    signal.throwIfAborted();
    const registration = resolveChannelPluginRegistration("telegram", { loadedOnly: true });
    const check = registration?.plugin.directory?.isGroupMember;
    if (!registration || !check) {
      return undefined;
    }
    const pluginIsCurrent = registration.captureReadAuthority?.();
    const links = await listCanonicalUserChannelIdentities(params.profileId, { signal });
    signal.throwIfAborted();
    for (const link of links) {
      const identity = link.identity;
      if (
        link.profileId !== params.profileId ||
        identity.channelId !== "telegram" ||
        identity.accountId !== params.accountId ||
        !/^[1-9]\d*$/.test(identity.senderId)
      ) {
        continue;
      }
      const authority = await prepareUserChannelIdentityAuthority(identity, { signal });
      signal.throwIfAborted();
      if (!authority || authority.linked.profileId !== params.profileId || !authority.isCurrent()) {
        continue;
      }
      const member = await check({
        cfg: params.cfg,
        accountId: params.accountId,
        groupId: params.groupId,
        memberId: identity.senderId,
        runtime: defaultRuntime,
        signal,
      });
      if (
        member === true &&
        !signal.aborted &&
        authority.isCurrent() &&
        (pluginIsCurrent?.() ?? true) &&
        resolveChannelPluginRegistration("telegram", { loadedOnly: true })?.plugin ===
          registration.plugin
      ) {
        return {
          isCurrent: () =>
            authority.isCurrent() &&
            (pluginIsCurrent?.() ?? true) &&
            resolveChannelPluginRegistration("telegram", { loadedOnly: true })?.plugin ===
              registration.plugin,
        };
      }
    }
  } catch {
    // Provider, identity, and registration failures never grant access.
  }
  return undefined;
}

/** Deduplicate checks and bound concurrency and total time for one read request. */
export async function prepareTelegramGroupMemberships(params: {
  cfg: OpenClawConfig;
  profileId: string;
  groups: readonly { accountId: string; groupId: string }[];
  signal?: AbortSignal;
}) {
  const signal = params.signal
    ? AbortSignal.any([params.signal, AbortSignal.timeout(5_000)])
    : AbortSignal.timeout(5_000);
  const groups = new Map<string, { accountId: string; groupId: string }>();
  for (const group of params.groups) {
    groups.set(JSON.stringify([group.accountId, group.groupId]), group);
  }
  const pending = [...groups];
  const facts = new Map<string, Awaited<ReturnType<typeof prepareTelegramGroupMembership>>>();
  let index = 0;
  const work = async () => {
    while (!signal.aborted) {
      const item = pending[index++];
      if (!item) {
        return;
      }
      const [key, group] = item;
      const fact = await prepareTelegramGroupMembership({
        cfg: params.cfg,
        profileId: params.profileId,
        ...group,
        signal,
      });
      if (!signal.aborted) {
        facts.set(key, fact);
      }
    }
  };
  if (signal.aborted) {
    return facts;
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([
      Promise.all(Array.from({ length: Math.min(4, pending.length) }, () => work())),
      aborted,
    ]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
  return facts;
}
