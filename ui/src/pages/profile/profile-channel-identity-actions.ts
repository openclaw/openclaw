import type {
  UsersLinkChannelIdentityResult,
  UsersListChannelIdentitiesResult,
  UsersUnlinkChannelIdentityResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { ProfileState } from "./profile-state.ts";

export type ChannelIdentityLink = UsersListChannelIdentitiesResult["links"][number];
export type ChannelIdentity = ChannelIdentityLink["identity"];
export type ChannelIdentityMutation = {
  kind: "link" | "unlink";
  profileId: string;
  identity: ChannelIdentity;
};
type ChannelIdentityTarget = {
  client: GatewayBrowserClient;
  profileId: string;
  identityRequestId: number;
};

export const sameChannelIdentity = (left: ChannelIdentity, right: ChannelIdentity) =>
  left.channelId === right.channelId &&
  left.accountId === right.accountId &&
  left.senderId === right.senderId;

export async function loadChannelIdentityLinks(state: ProfileState) {
  const target = currentChannelIdentityTarget(state);
  if (!target || state.channelIdentityMutation) {
    return;
  }
  const requestId = ++state.channelIdentityListRequestId;
  state.channelIdentityLoading = true;
  state.channelIdentityError = null;
  state.channelIdentityStatus = null;
  state.publish();
  try {
    const result = await target.client.request<UsersListChannelIdentitiesResult>(
      "users.listChannelIdentities",
      { profileId: target.profileId },
    );
    if (
      !isCurrentChannelIdentityTarget(state, target) ||
      requestId !== state.channelIdentityListRequestId
    ) {
      return;
    }
    state.channelIdentityLinks = result.links.filter((link) => link.profileId === target.profileId);
  } catch (error) {
    if (
      isCurrentChannelIdentityTarget(state, target) &&
      requestId === state.channelIdentityListRequestId
    ) {
      state.channelIdentityError = formatUiError(
        error,
        t("profilePage.channelIdentities.loadFailed"),
      );
    }
  } finally {
    if (
      isCurrentChannelIdentityTarget(state, target) &&
      requestId === state.channelIdentityListRequestId
    ) {
      state.channelIdentityLoading = false;
      state.publish();
    }
  }
}

export async function linkChannelIdentity(state: ProfileState) {
  const target = currentChannelIdentityTarget(state);
  const identity: ChannelIdentity = {
    channelId: state.channelId,
    accountId: state.accountId,
    senderId: state.senderId,
  };
  if (
    !target ||
    state.identityLoading ||
    state.identityBusy ||
    state.channelIdentityLoading ||
    state.channelIdentityLinks === null ||
    state.channelIdentityMutation ||
    !identity.channelId.trim() ||
    !identity.accountId.trim() ||
    !identity.senderId.trim()
  ) {
    return;
  }
  const mutationId = ++state.channelIdentityMutationId;
  state.channelIdentityListRequestId += 1;
  let mutationStatus: string | null = null;
  let mutationError: string | null = null;
  state.channelIdentityMutation = { kind: "link", profileId: target.profileId, identity };
  state.channelIdentityError = null;
  state.channelIdentityStatus = null;
  state.publish();
  try {
    const result = await target.client.request<UsersLinkChannelIdentityResult>(
      "users.linkChannelIdentity",
      { profileId: target.profileId, identity },
    );
    const currentTarget = await waitForCurrentChannelIdentityTarget(state, target);
    if (
      mutationId !== state.channelIdentityMutationId ||
      !currentTarget ||
      !isCurrentChannelIdentityTarget(state, currentTarget)
    ) {
      return;
    }
    if (result.profileId !== target.profileId || !sameChannelIdentity(result.identity, identity)) {
      throw new Error(t("profilePage.channelIdentities.linkFailed"));
    }
    const links = state.channelIdentityLinks ?? [];
    state.channelIdentityLinks = links.some((link) => sameChannelIdentity(link.identity, identity))
      ? links
      : [...links, result];
    state.channelId = "";
    state.accountId = "";
    state.senderId = "";
    mutationStatus = t("profilePage.channelIdentities.linked");
  } catch (error) {
    const currentTarget = await waitForCurrentChannelIdentityTarget(state, target);
    if (mutationId === state.channelIdentityMutationId && currentTarget) {
      mutationError = formatUiError(error, t("profilePage.channelIdentities.linkFailed"));
    }
  } finally {
    await settleChannelIdentityMutation(state, target, mutationId, mutationStatus, mutationError);
  }
}

export async function unlinkChannelIdentity(state: ProfileState, link: ChannelIdentityLink) {
  const target = currentChannelIdentityTarget(state);
  if (
    !target ||
    link.profileId !== target.profileId ||
    state.identityLoading ||
    state.identityBusy ||
    state.channelIdentityLoading ||
    state.channelIdentityMutation
  ) {
    return;
  }
  const mutationId = ++state.channelIdentityMutationId;
  state.channelIdentityListRequestId += 1;
  let mutationStatus: string | null = null;
  let mutationError: string | null = null;
  state.channelIdentityMutation = {
    kind: "unlink",
    profileId: target.profileId,
    identity: link.identity,
  };
  state.channelIdentityError = null;
  state.channelIdentityStatus = null;
  state.publish();
  try {
    await target.client.request<UsersUnlinkChannelIdentityResult>("users.unlinkChannelIdentity", {
      profileId: target.profileId,
      identity: link.identity,
    });
    const currentTarget = await waitForCurrentChannelIdentityTarget(state, target);
    if (
      mutationId !== state.channelIdentityMutationId ||
      !currentTarget ||
      !isCurrentChannelIdentityTarget(state, currentTarget)
    ) {
      return;
    }
    if (state.channelIdentityLinks !== null) {
      state.channelIdentityLinks = state.channelIdentityLinks.filter(
        (candidate) => !sameChannelIdentity(candidate.identity, link.identity),
      );
    }
    mutationStatus = t("profilePage.channelIdentities.unlinked");
  } catch (error) {
    const currentTarget = await waitForCurrentChannelIdentityTarget(state, target);
    if (mutationId === state.channelIdentityMutationId && currentTarget) {
      mutationError = formatUiError(error, t("profilePage.channelIdentities.unlinkFailed"));
    }
  } finally {
    await settleChannelIdentityMutation(state, target, mutationId, mutationStatus, mutationError);
  }
}

async function settleChannelIdentityMutation(
  state: ProfileState,
  target: ChannelIdentityTarget,
  mutationId: number,
  mutationStatus: string | null,
  mutationError: string | null,
) {
  if (mutationId === state.channelIdentityMutationId && target.client === state.client) {
    const reloadTarget = currentChannelIdentityTarget(state);
    state.channelIdentityMutation = null;
    if (reloadTarget) {
      await loadChannelIdentityLinks(state);
    }
    if (
      mutationId === state.channelIdentityMutationId &&
      reloadTarget &&
      isCurrentChannelIdentityTarget(state, reloadTarget)
    ) {
      if (mutationStatus) {
        state.channelIdentityStatus = mutationStatus;
      }
      if (mutationError) {
        state.channelIdentityError = mutationError;
      }
      state.publish();
    }
  }
}

function currentChannelIdentityTarget(state: ProfileState): ChannelIdentityTarget | null {
  const profile = state.ownProfile;
  const client = state.client;
  if (
    !client ||
    !state.canManageChannelIdentities() ||
    !state.canRead ||
    !state.channelIdentityProfileReady ||
    !profile
  ) {
    return null;
  }
  return { client, profileId: profile.id, identityRequestId: state.identityRequestId };
}

async function waitForCurrentChannelIdentityTarget(
  state: ProfileState,
  target: ChannelIdentityTarget,
): Promise<ChannelIdentityTarget | null> {
  if (isCurrentChannelIdentityTarget(state, target)) {
    return target;
  }
  if (target.client !== state.client || state.ownProfile?.id !== target.profileId) {
    return null;
  }
  const requestId = state.identityRequestId;
  if (state.identityLoading) {
    await state.identityReceipt.result;
  }
  if (requestId !== state.identityRequestId) {
    return null;
  }
  const current = currentChannelIdentityTarget(state);
  return current?.client === target.client && current.profileId === target.profileId
    ? current
    : null;
}

function isCurrentChannelIdentityTarget(state: ProfileState, target: ChannelIdentityTarget) {
  const current = currentChannelIdentityTarget(state);
  return (
    current?.client === target.client &&
    current.profileId === target.profileId &&
    current.identityRequestId === target.identityRequestId
  );
}
