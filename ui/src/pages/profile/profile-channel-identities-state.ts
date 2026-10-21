import type {
  UsersLinkChannelIdentityResult,
  UsersListChannelIdentitiesResult,
  UsersUnlinkChannelIdentityResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { observeState } from "../../lib/reactive/observe-state.ts";

type UserChannelIdentityLink = UsersListChannelIdentitiesResult["links"][number];
type UserChannelIdentity = UserChannelIdentityLink["identity"];
type ChannelIdentityMutation = {
  kind: "link" | "unlink";
  profileId: string;
  identity: UserChannelIdentity;
};

export type ProfileChannelIdentityGenerations = {
  request: number;
  target: number;
};

export type ProfileChannelIdentityBusyState = Readonly<{
  loading: boolean;
  mutation: boolean;
}>;

export type ProfileChannelIdentityInputs = {
  profileId: string | null;
  visible: boolean;
  profileReady: boolean;
  identityBusy: boolean;
  identityGeneration: number;
  targetGeneration: number;
  generations: ProfileChannelIdentityGenerations | null;
};

type ProfileChannelIdentityViewState = ProfileChannelIdentityInputs & {
  links: UserChannelIdentityLink[] | null;
  loading: boolean;
  error: string | null;
  status: string | null;
  mutation: ChannelIdentityMutation | null;
  channelId: string;
  accountId: string;
  senderId: string;
};

export type ProfileChannelIdentityView = ProfileChannelIdentityViewState & {
  busyState: ProfileChannelIdentityBusyState;
  canManageChannelIdentities: boolean;
  busy: boolean;
  formDisabled: boolean;
  isRemoving(link: UserChannelIdentityLink): boolean;
};

const EMPTY_INPUTS: ProfileChannelIdentityInputs = {
  profileId: null,
  visible: false,
  profileReady: false,
  identityBusy: false,
  identityGeneration: 0,
  targetGeneration: 0,
  generations: null,
};

const EMPTY_VIEW: ProfileChannelIdentityViewState = {
  ...EMPTY_INPUTS,
  links: null,
  loading: false,
  error: null,
  status: null,
  mutation: null,
  channelId: "",
  accountId: "",
  senderId: "",
};

function sameChannelIdentity(left: UserChannelIdentity, right: UserChannelIdentity): boolean {
  return (
    left.channelId === right.channelId &&
    left.accountId === right.accountId &&
    left.senderId === right.senderId
  );
}

export function sameConnectionScopes(
  left: readonly string[] | null,
  right: readonly string[] | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  const leftScopes = new Set(left);
  const rightScopes = new Set(right);
  return (
    leftScopes.size === rightScopes.size && [...leftScopes].every((scope) => rightScopes.has(scope))
  );
}

export function createProfileChannelIdentitiesState(
  onBusyStateChange?: (busyState: ProfileChannelIdentityBusyState) => void,
) {
  const projection = observeState({ view: { ...EMPTY_VIEW } });
  const view = projection.state.view;
  let reportBusyStateChange = onBusyStateChange;
  let client: GatewayBrowserClient | null = null;
  let connected = false;
  let canManage = false;
  let scopes: readonly string[] | null = null;
  let boundProfileId: string | null = null;
  let boundIdentityGeneration = 0;
  let boundTargetGeneration = 0;
  let boundSourceRequest = 0;
  let boundSourceTarget = 0;
  let boundProfileReady = false;
  let listRequestId = 0;
  let mutationId = 0;
  let lastReportedBusyState: ProfileChannelIdentityBusyState = { loading: false, mutation: false };

  const reportBusyState = () => {
    if (!reportBusyStateChange) {
      return;
    }
    const busyState = { loading: view.loading, mutation: view.mutation !== null };
    if (
      busyState.loading === lastReportedBusyState.loading &&
      busyState.mutation === lastReportedBusyState.mutation
    ) {
      return;
    }
    lastReportedBusyState = busyState;
    reportBusyStateChange(busyState);
  };

  const publish = (patch: Partial<ProfileChannelIdentityViewState>) => {
    Object.assign(view, patch);
    projection.invalidate();
    reportBusyState();
  };

  const hasAdminGrant = () => connected && scopes?.includes("operator.admin") === true;

  const canManageChannelIdentities = () =>
    view.visible &&
    client !== null &&
    hasAdminGrant() &&
    view.profileId !== null &&
    view.profileId !== GATEWAY_OWNER_PROFILE_ID;

  const parentGenerationCurrent = () =>
    view.generations?.request === view.identityGeneration &&
    view.generations?.target === view.targetGeneration;

  const canReadCurrentProfile = () =>
    canManageChannelIdentities() && view.profileReady && parentGenerationCurrent();

  const isCurrentTarget = (
    targetClient: GatewayBrowserClient,
    profileId: string,
    identityGeneration: number,
    targetGeneration: number,
  ) =>
    targetClient === client &&
    canReadCurrentProfile() &&
    view.profileId === profileId &&
    view.identityGeneration === identityGeneration &&
    view.targetGeneration === targetGeneration;

  const state = (): ProfileChannelIdentityView => {
    projection.read();
    const current = view;
    const busyState = { loading: current.loading, mutation: current.mutation !== null };
    const busy = current.loading || current.mutation !== null || current.identityBusy;
    return {
      ...current,
      busyState,
      canManageChannelIdentities: canManageChannelIdentities(),
      busy,
      formDisabled: busy || current.links === null,
      isRemoving: (link) =>
        current.mutation?.kind === "unlink" &&
        sameChannelIdentity(current.mutation.identity, link.identity),
    };
  };

  async function requestLinks() {
    const currentClient = client;
    const profileId = view.profileId;
    if (!currentClient || !profileId || !canReadCurrentProfile() || view.mutation) {
      return;
    }
    const identityGeneration = view.identityGeneration;
    const targetGeneration = view.targetGeneration;
    const requestId = ++listRequestId;
    publish({ loading: true, error: null, status: null });
    try {
      const result = await currentClient.request<UsersListChannelIdentitiesResult>(
        "users.listChannelIdentities",
        { profileId },
      );
      if (
        requestId !== listRequestId ||
        !isCurrentTarget(currentClient, profileId, identityGeneration, targetGeneration)
      ) {
        return;
      }
      publish({ links: result.links.filter((link) => link.profileId === profileId) });
    } catch (error) {
      if (
        requestId === listRequestId &&
        isCurrentTarget(currentClient, profileId, identityGeneration, targetGeneration)
      ) {
        publish({ error: formatUiError(error, t("profilePage.channelIdentities.loadFailed")) });
      }
    } finally {
      if (
        requestId === listRequestId &&
        isCurrentTarget(currentClient, profileId, identityGeneration, targetGeneration)
      ) {
        publish({ loading: false });
      }
    }
  }

  async function linkIdentity() {
    const currentClient = client;
    const profileId = view.profileId;
    const identity: UserChannelIdentity = {
      channelId: view.channelId,
      accountId: view.accountId,
      senderId: view.senderId,
    };
    if (
      !currentClient ||
      !profileId ||
      !canReadCurrentProfile() ||
      view.identityBusy ||
      view.loading ||
      view.links === null ||
      view.mutation ||
      !identity.channelId.trim() ||
      !identity.accountId.trim() ||
      !identity.senderId.trim()
    ) {
      return;
    }
    const identityGeneration = view.identityGeneration;
    const targetGeneration = view.targetGeneration;
    const currentMutationId = ++mutationId;
    listRequestId += 1;
    publish({
      mutation: { kind: "link", profileId, identity },
      error: null,
      status: null,
    });
    try {
      const result = await currentClient.request<UsersLinkChannelIdentityResult>(
        "users.linkChannelIdentity",
        { profileId, identity },
      );
      if (
        currentMutationId !== mutationId ||
        !isCurrentTarget(currentClient, profileId, identityGeneration, targetGeneration)
      ) {
        return;
      }
      if (result.profileId !== profileId || !sameChannelIdentity(result.identity, identity)) {
        throw new Error(t("profilePage.channelIdentities.linkFailed"));
      }
      const links = view.links ?? [];
      publish({
        links: links.some((link) => sameChannelIdentity(link.identity, identity))
          ? links
          : [...links, result],
        channelId: "",
        accountId: "",
        senderId: "",
        status: t("profilePage.channelIdentities.linked"),
      });
    } catch (error) {
      if (
        currentMutationId === mutationId &&
        isCurrentTarget(currentClient, profileId, identityGeneration, targetGeneration)
      ) {
        publish({ error: formatUiError(error, t("profilePage.channelIdentities.linkFailed")) });
      }
    } finally {
      if (currentMutationId === mutationId && currentClient === client) {
        const reload =
          !isCurrentTarget(currentClient, profileId, identityGeneration, targetGeneration) &&
          canReadCurrentProfile();
        if (reload) {
          view.mutation = null;
          void requestLinks();
        }
        publish({ mutation: null });
      }
    }
  }

  async function unlinkIdentity(link: UserChannelIdentityLink) {
    const currentClient = client;
    const profileId = view.profileId;
    if (
      !currentClient ||
      !profileId ||
      link.profileId !== profileId ||
      !canReadCurrentProfile() ||
      view.identityBusy ||
      view.loading ||
      view.mutation
    ) {
      return;
    }
    const identityGeneration = view.identityGeneration;
    const targetGeneration = view.targetGeneration;
    const currentMutationId = ++mutationId;
    listRequestId += 1;
    publish({
      mutation: { kind: "unlink", profileId, identity: link.identity },
      error: null,
      status: null,
    });
    try {
      await currentClient.request<UsersUnlinkChannelIdentityResult>("users.unlinkChannelIdentity", {
        profileId,
        identity: link.identity,
      });
      if (
        currentMutationId !== mutationId ||
        !isCurrentTarget(currentClient, profileId, identityGeneration, targetGeneration)
      ) {
        return;
      }
      publish({
        links: (view.links ?? []).filter(
          (candidate) => !sameChannelIdentity(candidate.identity, link.identity),
        ),
        status: t("profilePage.channelIdentities.unlinked"),
      });
    } catch (error) {
      if (
        currentMutationId === mutationId &&
        isCurrentTarget(currentClient, profileId, identityGeneration, targetGeneration)
      ) {
        publish({ error: formatUiError(error, t("profilePage.channelIdentities.unlinkFailed")) });
      }
    } finally {
      if (currentMutationId === mutationId && currentClient === client) {
        const reload =
          !isCurrentTarget(currentClient, profileId, identityGeneration, targetGeneration) &&
          canReadCurrentProfile();
        if (reload) {
          view.mutation = null;
          void requestLinks();
        }
        publish({ mutation: null });
      }
    }
  }

  return {
    state,
    update(nextInputs: ProfileChannelIdentityInputs, snapshot: ApplicationGatewaySnapshot) {
      const visibleChanged = view.visible !== nextInputs.visible;
      const identityBusyChanged = view.identityBusy !== nextInputs.identityBusy;
      Object.assign(view, nextInputs);

      const nextConnected = snapshot.phase === "connected" && snapshot.client !== null;
      const nextClient = nextConnected ? snapshot.client : null;
      const nextScopes = nextConnected ? (snapshot.hello?.auth?.scopes ?? null) : null;
      const nextCanManage = nextConnected && nextScopes?.includes("operator.admin") === true;
      const sourceRequest = view.generations?.request ?? view.identityGeneration;
      const sourceTarget = view.generations?.target ?? view.targetGeneration;
      const targetChanged =
        nextClient !== client ||
        nextConnected !== connected ||
        view.profileId !== boundProfileId ||
        view.targetGeneration !== boundTargetGeneration ||
        sourceTarget !== boundSourceTarget;
      const requestChanged =
        view.identityGeneration !== boundIdentityGeneration || sourceRequest !== boundSourceRequest;
      const grantChanged = nextCanManage !== canManage || !sameConnectionScopes(scopes, nextScopes);
      const profileReadyChanged = view.profileReady !== boundProfileReady;

      client = nextClient;
      connected = nextConnected;
      canManage = nextCanManage;
      scopes = nextScopes ? [...nextScopes] : nextScopes;

      if (!targetChanged && !requestChanged && !grantChanged && !profileReadyChanged) {
        if (visibleChanged || identityBusyChanged) {
          projection.invalidate();
          reportBusyState();
        }
        return;
      }
      boundProfileId = view.profileId;
      boundIdentityGeneration = view.identityGeneration;
      boundTargetGeneration = view.targetGeneration;
      boundSourceRequest = sourceRequest;
      boundSourceTarget = sourceTarget;
      boundProfileReady = view.profileReady;
      listRequestId += 1;
      Object.assign(view, {
        links: null,
        loading: false,
        error: null,
        status: null,
      });

      if (targetChanged) {
        mutationId += 1;
        Object.assign(view, {
          mutation: null,
          channelId: "",
          accountId: "",
          senderId: "",
        });
      }

      projection.invalidate();
      reportBusyState();
      if (canReadCurrentProfile() && !view.mutation) {
        void requestLinks();
      }
    },
    dispose() {
      listRequestId += 1;
      mutationId += 1;
      client = null;
      connected = false;
      canManage = false;
      scopes = null;
      Object.assign(view, EMPTY_VIEW);
      reportBusyStateChange = undefined;
      projection.dispose();
    },
    setDraft(field: "channelId" | "accountId" | "senderId", value: string) {
      publish({ [field]: value });
    },
    loadLinks() {
      return requestLinks();
    },
    linkIdentity,
    unlinkIdentity,
  };
}

export type ProfileChannelIdentitiesState = ReturnType<typeof createProfileChannelIdentitiesState>;
