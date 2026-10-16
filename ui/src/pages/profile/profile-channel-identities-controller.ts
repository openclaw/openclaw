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

function sameChannelIdentity(left: UserChannelIdentity, right: UserChannelIdentity): boolean {
  return (
    left.channelId === right.channelId &&
    left.accountId === right.accountId &&
    left.senderId === right.senderId
  );
}

function sameConnectionScopes(
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

export class ProfileChannelIdentitiesController {
  profileId: string | null = null;
  visible = false;
  profileReady = false;
  identityBusy = false;
  identityGeneration = 0;
  targetGeneration = 0;
  generations: ProfileChannelIdentityGenerations | null = null;

  links: UserChannelIdentityLink[] | null = null;
  loading = false;
  error: string | null = null;
  status: string | null = null;
  mutation: ChannelIdentityMutation | null = null;
  channelId = "";
  accountId = "";
  senderId = "";

  private client: GatewayBrowserClient | null = null;
  private connected = false;
  private canManage = false;
  private scopes: readonly string[] | null = null;
  private boundProfileId: string | null = null;
  private boundIdentityGeneration = 0;
  private boundTargetGeneration = 0;
  private boundSourceRequest = 0;
  private boundSourceTarget = 0;
  private boundProfileReady = false;
  private listRequestId = 0;
  private mutationId = 0;

  constructor(private readonly notify: () => void) {}

  get busyState(): ProfileChannelIdentityBusyState {
    return { loading: this.loading, mutation: this.mutation !== null };
  }

  get canManageChannelIdentities() {
    return (
      this.visible &&
      this.client !== null &&
      this.hasAdminGrant &&
      this.profileId !== null &&
      this.profileId !== GATEWAY_OWNER_PROFILE_ID
    );
  }

  get busy() {
    return this.loading || this.mutation !== null || this.identityBusy;
  }

  get formDisabled() {
    return this.busy || this.links === null;
  }

  isRemoving(link: UserChannelIdentityLink) {
    return (
      this.mutation?.kind === "unlink" && sameChannelIdentity(this.mutation.identity, link.identity)
    );
  }

  setDraft(field: "channelId" | "accountId" | "senderId", value: string) {
    this[field] = value;
    this.notify();
  }

  update(inputs: ProfileChannelIdentityInputs, snapshot: ApplicationGatewaySnapshot) {
    const visibleChanged = this.visible !== inputs.visible;
    const identityBusyChanged = this.identityBusy !== inputs.identityBusy;
    this.profileId = inputs.profileId;
    this.visible = inputs.visible;
    this.profileReady = inputs.profileReady;
    this.identityBusy = inputs.identityBusy;
    this.identityGeneration = inputs.identityGeneration;
    this.targetGeneration = inputs.targetGeneration;
    this.generations = inputs.generations;

    const nextConnected = snapshot.phase === "connected" && snapshot.client !== null;
    const nextClient = nextConnected ? snapshot.client : null;
    const nextScopes = nextConnected ? (snapshot.hello?.auth?.scopes ?? null) : null;
    const nextCanManage = nextConnected && nextScopes?.includes("operator.admin") === true;
    const sourceRequest = this.generations?.request ?? this.identityGeneration;
    const sourceTarget = this.generations?.target ?? this.targetGeneration;
    const targetChanged =
      nextClient !== this.client ||
      nextConnected !== this.connected ||
      this.profileId !== this.boundProfileId ||
      this.targetGeneration !== this.boundTargetGeneration ||
      sourceTarget !== this.boundSourceTarget;
    const requestChanged =
      this.identityGeneration !== this.boundIdentityGeneration ||
      sourceRequest !== this.boundSourceRequest;
    const grantChanged =
      nextCanManage !== this.canManage || !sameConnectionScopes(this.scopes, nextScopes);
    const profileReadyChanged = this.profileReady !== this.boundProfileReady;

    this.client = nextClient;
    this.connected = nextConnected;
    this.canManage = nextCanManage;
    this.scopes = nextScopes ? [...nextScopes] : nextScopes;

    if (!targetChanged && !requestChanged && !grantChanged && !profileReadyChanged) {
      if (visibleChanged || identityBusyChanged) {
        this.notify();
      }
      return;
    }
    this.boundProfileId = this.profileId;
    this.boundIdentityGeneration = this.identityGeneration;
    this.boundTargetGeneration = this.targetGeneration;
    this.boundSourceRequest = sourceRequest;
    this.boundSourceTarget = sourceTarget;
    this.boundProfileReady = this.profileReady;
    this.listRequestId += 1;
    this.links = null;
    this.loading = false;
    this.error = null;
    this.status = null;

    if (targetChanged) {
      this.mutationId += 1;
      this.mutation = null;
      this.channelId = "";
      this.accountId = "";
      this.senderId = "";
    }

    this.notify();
    if (this.canReadCurrentProfile() && !this.mutation) {
      void this.loadLinks();
    }
  }

  dispose() {
    this.listRequestId += 1;
    this.mutationId += 1;
    this.client = null;
    this.connected = false;
    this.canManage = false;
    this.scopes = null;
    this.links = null;
    this.loading = false;
    this.error = null;
    this.status = null;
    this.mutation = null;
    this.channelId = "";
    this.accountId = "";
    this.senderId = "";
  }

  private get hasAdminGrant() {
    return this.connected && this.scopes?.includes("operator.admin") === true;
  }

  private get parentGenerationCurrent() {
    return (
      this.generations?.request === this.identityGeneration &&
      this.generations?.target === this.targetGeneration
    );
  }

  private canReadCurrentProfile() {
    return this.canManageChannelIdentities && this.profileReady && this.parentGenerationCurrent;
  }

  private isCurrentTarget(
    client: GatewayBrowserClient,
    profileId: string,
    identityGeneration: number,
    targetGeneration: number,
  ) {
    return (
      client === this.client &&
      this.canReadCurrentProfile() &&
      this.profileId === profileId &&
      this.identityGeneration === identityGeneration &&
      this.targetGeneration === targetGeneration
    );
  }

  async loadLinks() {
    const client = this.client;
    const profileId = this.profileId;
    if (!client || !profileId || !this.canReadCurrentProfile() || this.mutation) {
      return;
    }
    const identityGeneration = this.identityGeneration;
    const targetGeneration = this.targetGeneration;
    const requestId = ++this.listRequestId;
    this.loading = true;
    this.error = null;
    this.status = null;
    this.notify();
    try {
      const result = await client.request<UsersListChannelIdentitiesResult>(
        "users.listChannelIdentities",
        { profileId },
      );
      if (
        requestId !== this.listRequestId ||
        !this.isCurrentTarget(client, profileId, identityGeneration, targetGeneration)
      ) {
        return;
      }
      this.links = result.links.filter((link) => link.profileId === profileId);
      this.notify();
    } catch (error) {
      if (
        requestId === this.listRequestId &&
        this.isCurrentTarget(client, profileId, identityGeneration, targetGeneration)
      ) {
        this.error = formatUiError(error, t("profilePage.channelIdentities.loadFailed"));
        this.notify();
      }
    } finally {
      if (
        requestId === this.listRequestId &&
        this.isCurrentTarget(client, profileId, identityGeneration, targetGeneration)
      ) {
        this.loading = false;
        this.notify();
      }
    }
  }

  async linkIdentity() {
    const client = this.client;
    const profileId = this.profileId;
    const identity: UserChannelIdentity = {
      channelId: this.channelId,
      accountId: this.accountId,
      senderId: this.senderId,
    };
    if (
      !client ||
      !profileId ||
      !this.canReadCurrentProfile() ||
      this.identityBusy ||
      this.loading ||
      this.links === null ||
      this.mutation ||
      !identity.channelId.trim() ||
      !identity.accountId.trim() ||
      !identity.senderId.trim()
    ) {
      return;
    }
    const identityGeneration = this.identityGeneration;
    const targetGeneration = this.targetGeneration;
    const mutationId = ++this.mutationId;
    this.listRequestId += 1;
    this.mutation = { kind: "link", profileId, identity };
    this.error = null;
    this.status = null;
    this.notify();
    try {
      const result = await client.request<UsersLinkChannelIdentityResult>(
        "users.linkChannelIdentity",
        { profileId, identity },
      );
      if (
        mutationId !== this.mutationId ||
        !this.isCurrentTarget(client, profileId, identityGeneration, targetGeneration)
      ) {
        return;
      }
      if (result.profileId !== profileId || !sameChannelIdentity(result.identity, identity)) {
        throw new Error(t("profilePage.channelIdentities.linkFailed"));
      }
      const links = this.links ?? [];
      if (!links.some((link) => sameChannelIdentity(link.identity, identity))) {
        this.links = [...links, result];
      }
      this.channelId = "";
      this.accountId = "";
      this.senderId = "";
      this.status = t("profilePage.channelIdentities.linked");
      this.notify();
    } catch (error) {
      if (
        mutationId === this.mutationId &&
        this.isCurrentTarget(client, profileId, identityGeneration, targetGeneration)
      ) {
        this.error = formatUiError(error, t("profilePage.channelIdentities.linkFailed"));
        this.notify();
      }
    } finally {
      if (mutationId === this.mutationId && client === this.client) {
        this.mutation = null;
        if (
          !this.isCurrentTarget(client, profileId, identityGeneration, targetGeneration) &&
          this.canReadCurrentProfile()
        ) {
          void this.loadLinks();
        }
        this.notify();
      }
    }
  }

  async unlinkIdentity(link: UserChannelIdentityLink) {
    const client = this.client;
    const profileId = this.profileId;
    if (
      !client ||
      !profileId ||
      link.profileId !== profileId ||
      !this.canReadCurrentProfile() ||
      this.identityBusy ||
      this.loading ||
      this.mutation
    ) {
      return;
    }
    const identityGeneration = this.identityGeneration;
    const targetGeneration = this.targetGeneration;
    const mutationId = ++this.mutationId;
    this.listRequestId += 1;
    this.mutation = { kind: "unlink", profileId, identity: link.identity };
    this.error = null;
    this.status = null;
    this.notify();
    try {
      await client.request<UsersUnlinkChannelIdentityResult>("users.unlinkChannelIdentity", {
        profileId,
        identity: link.identity,
      });
      if (
        mutationId !== this.mutationId ||
        !this.isCurrentTarget(client, profileId, identityGeneration, targetGeneration)
      ) {
        return;
      }
      this.links = (this.links ?? []).filter(
        (candidate) => !sameChannelIdentity(candidate.identity, link.identity),
      );
      this.status = t("profilePage.channelIdentities.unlinked");
      this.notify();
    } catch (error) {
      if (
        mutationId === this.mutationId &&
        this.isCurrentTarget(client, profileId, identityGeneration, targetGeneration)
      ) {
        this.error = formatUiError(error, t("profilePage.channelIdentities.unlinkFailed"));
        this.notify();
      }
    } finally {
      if (mutationId === this.mutationId && client === this.client) {
        this.mutation = null;
        if (
          !this.isCurrentTarget(client, profileId, identityGeneration, targetGeneration) &&
          this.canReadCurrentProfile()
        ) {
          void this.loadLinks();
        }
        this.notify();
      }
    }
  }
}
