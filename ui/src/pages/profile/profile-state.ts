import type {
  UserProfile,
  UsersLinkChannelIdentityResult,
  UsersListChannelIdentitiesResult,
  UsersSetAvatarResult,
  UsersSetDisplayNameResult,
  UsersUnlinkChannelIdentityResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import {
  GATEWAY_OWNER_PROFILE_ID,
  GIT_COAUTHOR_PREFERENCE_KEY,
  PR_ATTRIBUTION_PREFERENCE_KEY,
  isGitCoauthorCreditEnabled,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context-types.ts";
import { hasOperatorSelfReadAccess } from "../../app/operator-access.ts";
import { invalidateUserPreferences, saveUserPreferences } from "../../app/user-prefs-cache.ts";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import { resolveCurrentSelfUser } from "../../app/user-profile.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { assertUploadsEnabled } from "../../lib/uploads.ts";
import { processProfileAvatar, ProfileAvatarError } from "./avatar-processing.ts";
import type { ModelAccountsTargetSource } from "./model-accounts-state.ts";
import { userProfileAvatarUrl } from "./profile-avatar-url.ts";
import { sameConnectionScopes } from "./profile-connection-scopes.ts";

type ChannelIdentityLink = UsersListChannelIdentitiesResult["links"][number];
type ChannelIdentity = ChannelIdentityLink["identity"];
type ChannelIdentityMutation = {
  kind: "link" | "unlink";
  profileId: string;
  identity: ChannelIdentity;
};
type ChannelIdentityTarget = {
  client: GatewayBrowserClient;
  profileId: string;
  identityRequestId: number;
};

const sameChannelIdentity = (left: ChannelIdentity, right: ChannelIdentity) =>
  left.channelId === right.channelId &&
  left.accountId === right.accountId &&
  left.senderId === right.senderId;

export type IdentityChange =
  | { kind: "display-name" }
  | { kind: "avatar"; file: File }
  | { kind: "git-coauthor" | "pr-attribution"; enabled: boolean };

export class ProfileState {
  private publishTarget?: () => void;
  private channelIdentityListRequestId = 0;
  private channelIdentityMutationId = 0;
  readonly modelAccountsTarget: ModelAccountsTargetSource = {
    read: () => ({
      gateway: this.context.gateway.snapshot,
      identityId: this.selfUser?.id ?? null,
      profileId: this.ownProfile?.id ?? null,
    }),
    subscribe: (listener) => {
      this.publishTarget = listener;
      return () => {
        this.publishTarget = undefined;
      };
    },
  };
  selfUser: AuthenticatedUser | null = null;
  ownProfile: UserProfile | null = null;
  displayName = "";
  gitCoauthorEnabled = true;
  prAttributionEnabled = false;
  identityLoading = false;
  identityBusy: IdentityChange["kind"] | null = null;
  identityError: string | null = null;

  client: GatewayBrowserClient | null = null;
  connected = false;
  identityReady = false;
  connecting = false;
  canRead = false;
  canWrite = false;
  connectionScopes: readonly string[] | null = null;
  identityRequestId = 0;
  identityScope = {};
  presentationLifetime = Promise.withResolvers<void>();
  identityReceipt = { result: Promise.resolve() };
  hello: ApplicationGatewaySnapshot["hello"] | undefined;
  channelIdentityProfileId: string | null = null;
  channelIdentityProfileReady = false;
  channelIdentityLinks: ChannelIdentityLink[] | null = null;
  channelIdentityLoading = false;
  channelIdentityError: string | null = null;
  channelIdentityStatus: string | null = null;
  channelIdentityMutation: ChannelIdentityMutation | null = null;
  channelId = "";
  accountId = "";
  senderId = "";

  get channelIdentityBusy() {
    return this.channelIdentityLoading || this.channelIdentityMutation !== null;
  }
  get channelIdentityFormDisabled() {
    return (
      this.channelIdentityBusy ||
      this.identityLoading ||
      this.identityBusy !== null ||
      this.channelIdentityLinks === null
    );
  }

  constructor(
    readonly context: ApplicationContext,
    private readonly invalidate: () => void,
  ) {}
  publish() {
    this.invalidate();
    this.publishTarget?.();
  }
  retirePresentation() {
    this.presentationLifetime.resolve();
    this.presentationLifetime = Promise.withResolvers<void>();
  }
  dispose() {
    this.publishTarget = undefined;
    this.retirePresentation();
    this.identityRequestId += 1;
    this.resetChannelIdentityState(true);
    this.channelIdentityProfileId = null;
    this.client = null;
    this.connected = false;
    this.identityReady = false;
  }
  applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const clientChanged = snapshot.client !== this.client;
    const nextConnected = snapshot.phase === "connected";
    // Hello can precede users.self; unresolved identity is not a sign-out.
    const identityReady = nextConnected && snapshot.selfUser !== undefined;
    const nextCanRead = hasOperatorSelfReadAccess(snapshot.hello?.auth ?? null);
    // Personal identity edits do not grant general server or session write access.
    const nextCanWrite = nextConnected && nextCanRead;
    const connectionChanged =
      nextConnected !== this.connected ||
      identityReady !== this.identityReady ||
      (nextConnected && this.hello !== snapshot.hello);
    const nextSelfUser = identityReady
      ? resolveCurrentSelfUser({ snapshotUser: snapshot.selfUser })
      : clientChanged
        ? null
        : this.selfUser;
    const selfProfileChanged =
      nextSelfUser?.id !== this.selfUser?.id ||
      nextSelfUser?.identity?.id !== this.selfUser?.identity?.id;
    const identityTargetChanged =
      clientChanged ||
      nextConnected !== this.connected ||
      identityReady !== this.identityReady ||
      selfProfileChanged;
    const readAccessLost = nextConnected && this.canRead && !nextCanRead;
    const nextConnectionScopes = snapshot.hello?.auth?.scopes ?? null;
    const connectionScopesChanged =
      (nextConnected || clientChanged) &&
      !sameConnectionScopes(this.connectionScopes, nextConnected ? nextConnectionScopes : null);
    const identitySourceChanged = clientChanged || selfProfileChanged || readAccessLost;
    this.client = snapshot.client;
    this.connected = nextConnected;
    this.identityReady = identityReady;
    this.hello = snapshot.hello;
    this.connecting = snapshot.phase === "connecting" || snapshot.phase === "reconnecting";
    this.canRead = nextConnected ? nextCanRead : clientChanged ? false : this.canRead;
    this.canWrite = nextCanWrite && identityReady;
    // Hello records this connection's negotiated grants, not the profile's role ceiling.
    this.connectionScopes =
      nextConnected || clientChanged
        ? (snapshot.hello?.auth?.scopes ?? null)
        : this.connectionScopes;
    this.selfUser = nextSelfUser;
    if (identitySourceChanged || connectionChanged || connectionScopesChanged) {
      this.retirePresentation();
      this.identityRequestId += 1;
      this.identityScope = {};
      this.identityReceipt = { result: Promise.resolve() };
      this.identityLoading = false;
      this.identityBusy = null;
      this.identityError = null;
      this.channelIdentityProfileReady = false;
      this.resetChannelIdentityState(identityTargetChanged, connectionScopesChanged);
      if (identityTargetChanged) {
        this.channelIdentityProfileId = null;
      }
    }
    if (identitySourceChanged) {
      this.ownProfile = null;
      this.displayName = "";
      this.gitCoauthorEnabled = true;
      this.prAttributionEnabled = false;
    }
    this.publish();
    if (!identityReady || !snapshot.client) {
      return;
    }
    if (identitySourceChanged || connectionChanged) {
      this.loadIdentity();
    }
    void this.context.agents.ensureList().then((list) => {
      if (list) {
        void this.context.agentIdentity.ensure([list.defaultId]);
      }
    });
  }

  loadIdentity() {
    const client = this.client;
    if (!client || !this.identityReady || !this.canRead || this.identityLoading) {
      return;
    }
    const requestId = ++this.identityRequestId;
    const currentProfile = this.ownProfile;
    const displayNameDraft = this.displayName;
    const hasUnsavedDisplayName =
      currentProfile !== null && displayNameDraft.trim() !== (currentProfile.displayName ?? "");
    this.identityLoading = true;
    this.identityError = null;
    this.channelIdentityProfileReady = false;
    this.resetChannelIdentityState(false);
    const result = this.readIdentity(client, requestId, hasUnsavedDisplayName, displayNameDraft);
    this.identityReceipt = { result };
    this.publish();
  }

  private async readIdentity(
    client: GatewayBrowserClient,
    requestId: number,
    hasUnsavedDisplayName: boolean,
    displayNameDraft: string,
  ) {
    try {
      const profile = await this.context.gateway.loadSelfProfile();
      if (requestId !== this.identityRequestId) {
        return;
      }
      if (profile?.id !== this.channelIdentityProfileId) {
        this.resetChannelIdentityState(true);
      }
      this.ownProfile = profile;
      this.channelIdentityProfileId = profile?.id ?? null;
      this.channelIdentityProfileReady = true;
      if (!profile) {
        this.publish();
        return;
      }
      this.displayName = hasUnsavedDisplayName ? displayNameDraft : (profile.displayName ?? "");
      this.gitCoauthorEnabled = true;
      this.prAttributionEnabled = false;
      this.publish();
      void this.loadChannelIdentityLinks();
      // Consent belongs to the person, not to a display-primary GitHub account.
      const { loadUserPreferences } = await import("../../app/user-prefs-request.ts");
      if (requestId !== this.identityRequestId) {
        return;
      }
      const preferencesPromise = loadUserPreferences(client, profile.id, {
        keys:
          profile.id === GATEWAY_OWNER_PROFILE_ID
            ? [PR_ATTRIBUTION_PREFERENCE_KEY]
            : [GIT_COAUTHOR_PREFERENCE_KEY, PR_ATTRIBUTION_PREFERENCE_KEY],
      });
      const preferences = await preferencesPromise;
      if (requestId !== this.identityRequestId) {
        return;
      }
      this.gitCoauthorEnabled =
        profile.id !== GATEWAY_OWNER_PROFILE_ID &&
        preferences.status === "ok" &&
        isGitCoauthorCreditEnabled(preferences.entries[GIT_COAUTHOR_PREFERENCE_KEY]);
      this.prAttributionEnabled =
        preferences.status === "ok" && preferences.entries[PR_ATTRIBUTION_PREFERENCE_KEY] === true;
    } catch (error) {
      if (requestId === this.identityRequestId) {
        this.identityError = formatUiError(error, t("profilePage.identity.profileUnavailable"));
      }
    } finally {
      if (requestId === this.identityRequestId) {
        this.identityLoading = false;
        this.publish();
      }
    }
  }

  async saveIdentity(change: IdentityChange) {
    const client = this.client;
    const profile = this.ownProfile;
    if (
      !client ||
      !profile ||
      !this.canWrite ||
      this.identityBusy ||
      this.identityLoading ||
      (change.kind === "git-coauthor" && profile.id === GATEWAY_OWNER_PROFILE_ID)
    ) {
      return;
    }
    this.identityBusy = change.kind;
    this.identityError = null;
    this.publish();
    const identityRequestId = this.identityRequestId;
    const isCurrent = () => client === this.client && identityRequestId === this.identityRequestId;
    try {
      switch (change.kind) {
        case "display-name": {
          const result = await client.request<UsersSetDisplayNameResult>("users.setDisplayName", {
            profileId: profile.id,
            displayName: this.displayName.trim() || null,
          });
          if (!isCurrent()) {
            return;
          }
          this.ownProfile = result.profile;
          this.displayName = result.profile.displayName ?? "";
          this.context.gateway.updateSelfUser?.({ name: result.profile.displayName ?? undefined });
          break;
        }
        case "avatar": {
          assertUploadsEnabled(this.context.config);
          const displayNameDraft = this.displayName;
          const hasUnsavedDisplayName = displayNameDraft.trim() !== (profile.displayName ?? "");
          const selfAvatarUrlBefore =
            this.selfUser?.id === profile.id ? this.selfUser.avatarUrl : undefined;
          const avatar = await processProfileAvatar(change.file);
          if (!isCurrent()) {
            return;
          }
          assertUploadsEnabled(this.context.config);
          const result = await client.request<UsersSetAvatarResult>("users.setAvatar", {
            profileId: profile.id,
            mime: avatar.mime,
            avatarBase64: avatar.avatarBase64,
          });
          if (!isCurrent()) {
            return;
          }
          this.ownProfile = result.profile;
          this.displayName = hasUnsavedDisplayName
            ? displayNameDraft
            : (result.profile.displayName ?? "");
          const avatarUrl = userProfileAvatarUrl(
            this.context.gateway.connection.gatewayUrl,
            result.profile.id,
            result.avatarRevision,
            this.context.resourceBasePath,
          );
          const presenceAvatarChanged =
            this.selfUser?.id === result.profile.id &&
            this.selfUser.avatarUrl !== selfAvatarUrlBefore;
          if (avatarUrl && !presenceAvatarChanged) {
            this.context.gateway.updateSelfUser?.({ avatarUrl });
          }
          break;
        }
        case "git-coauthor":
        case "pr-attribution": {
          const key =
            change.kind === "git-coauthor"
              ? GIT_COAUTHOR_PREFERENCE_KEY
              : PR_ATTRIBUTION_PREFERENCE_KEY;
          const result = await saveUserPreferences(client, {
            entries: { [key]: change.enabled },
          });
          if (!isCurrent()) {
            return;
          }
          if (result.status !== "ok") {
            throw new Error(t("profilePage.identity.profileUnavailable"));
          }
          if (change.kind === "git-coauthor") {
            this.gitCoauthorEnabled = change.enabled;
          } else {
            this.prAttributionEnabled = change.enabled;
          }
          return;
        }
      }
    } catch (error) {
      if (isCurrent()) {
        this.identityError =
          change.kind === "avatar" && error instanceof ProfileAvatarError
            ? t(
                error.code === "too-large"
                  ? "profilePage.identity.avatarErrors.tooLarge"
                  : error.code === "source-too-large"
                    ? "profilePage.identity.avatarErrors.sourceTooLarge"
                    : "profilePage.identity.avatarErrors.invalid",
              )
            : formatUiError(error, t("profilePage.identity.profileUnavailable"));
      }
      return;
    } finally {
      if (isCurrent() && this.identityBusy === change.kind) {
        this.identityBusy = null;
        this.publish();
      }
    }
    if (isCurrent()) {
      this.loadIdentity();
      return this.identityReceipt.result;
    }
  }

  refreshManually() {
    if (
      this.identityReady &&
      !this.identityBusy &&
      !this.identityLoading &&
      !this.channelIdentityBusy
    ) {
      if (this.client) {
        invalidateUserPreferences(this.client);
      }
      this.loadIdentity();
    }
  }

  canManageChannelIdentities() {
    return (
      this.connected &&
      this.identityReady &&
      this.canRead &&
      this.client !== null &&
      this.connectionScopes?.includes("operator.admin") === true &&
      this.ownProfile !== null &&
      this.ownProfile.id === this.channelIdentityProfileId &&
      this.ownProfile.id !== GATEWAY_OWNER_PROFILE_ID
    );
  }

  isRemovingChannelIdentity(link: ChannelIdentityLink) {
    return (
      this.channelIdentityMutation?.kind === "unlink" &&
      sameChannelIdentity(this.channelIdentityMutation.identity, link.identity)
    );
  }

  setChannelIdentityDraft(field: "channelId" | "accountId" | "senderId", value: string) {
    this[field] = value;
    this.publish();
  }

  async loadChannelIdentityLinks() {
    const target = this.currentChannelIdentityTarget();
    if (!target || this.channelIdentityMutation) {
      return;
    }
    const requestId = ++this.channelIdentityListRequestId;
    this.channelIdentityLoading = true;
    this.channelIdentityError = null;
    this.channelIdentityStatus = null;
    this.publish();
    try {
      const result = await target.client.request<UsersListChannelIdentitiesResult>(
        "users.listChannelIdentities",
        { profileId: target.profileId },
      );
      if (
        !this.isCurrentChannelIdentityTarget(target) ||
        requestId !== this.channelIdentityListRequestId
      ) {
        return;
      }
      this.channelIdentityLinks = result.links.filter(
        (link) => link.profileId === target.profileId,
      );
    } catch (error) {
      if (
        this.isCurrentChannelIdentityTarget(target) &&
        requestId === this.channelIdentityListRequestId
      ) {
        this.channelIdentityError = formatUiError(
          error,
          t("profilePage.channelIdentities.loadFailed"),
        );
      }
    } finally {
      if (
        this.isCurrentChannelIdentityTarget(target) &&
        requestId === this.channelIdentityListRequestId
      ) {
        this.channelIdentityLoading = false;
        this.publish();
      }
    }
  }

  async linkChannelIdentity() {
    const target = this.currentChannelIdentityTarget();
    const identity: ChannelIdentity = {
      channelId: this.channelId,
      accountId: this.accountId,
      senderId: this.senderId,
    };
    if (
      !target ||
      this.identityLoading ||
      this.identityBusy ||
      this.channelIdentityLoading ||
      this.channelIdentityLinks === null ||
      this.channelIdentityMutation ||
      !identity.channelId.trim() ||
      !identity.accountId.trim() ||
      !identity.senderId.trim()
    ) {
      return;
    }
    const mutationId = ++this.channelIdentityMutationId;
    this.channelIdentityListRequestId += 1;
    let mutationStatus: string | null = null;
    let mutationError: string | null = null;
    this.channelIdentityMutation = { kind: "link", profileId: target.profileId, identity };
    this.channelIdentityError = null;
    this.channelIdentityStatus = null;
    this.publish();
    try {
      const result = await target.client.request<UsersLinkChannelIdentityResult>(
        "users.linkChannelIdentity",
        { profileId: target.profileId, identity },
      );
      const currentTarget = await this.waitForCurrentChannelIdentityTarget(target);
      if (
        mutationId !== this.channelIdentityMutationId ||
        !currentTarget ||
        !this.isCurrentChannelIdentityTarget(currentTarget)
      ) {
        return;
      }
      if (
        result.profileId !== target.profileId ||
        !sameChannelIdentity(result.identity, identity)
      ) {
        throw new Error(t("profilePage.channelIdentities.linkFailed"));
      }
      const links = this.channelIdentityLinks ?? [];
      this.channelIdentityLinks = links.some((link) => sameChannelIdentity(link.identity, identity))
        ? links
        : [...links, result];
      this.channelId = "";
      this.accountId = "";
      this.senderId = "";
      mutationStatus = t("profilePage.channelIdentities.linked");
    } catch (error) {
      const currentTarget = await this.waitForCurrentChannelIdentityTarget(target);
      if (mutationId === this.channelIdentityMutationId && currentTarget) {
        mutationError = formatUiError(error, t("profilePage.channelIdentities.linkFailed"));
      }
    } finally {
      if (mutationId === this.channelIdentityMutationId && target.client === this.client) {
        const reloadTarget = this.currentChannelIdentityTarget();
        this.channelIdentityMutation = null;
        if (reloadTarget) {
          await this.loadChannelIdentityLinks();
        }
        if (
          mutationId === this.channelIdentityMutationId &&
          reloadTarget &&
          this.isCurrentChannelIdentityTarget(reloadTarget)
        ) {
          if (mutationStatus) {
            this.channelIdentityStatus = mutationStatus;
          }
          if (mutationError) {
            this.channelIdentityError = mutationError;
          }
          this.publish();
        }
      }
    }
  }

  async unlinkChannelIdentity(link: ChannelIdentityLink) {
    const target = this.currentChannelIdentityTarget();
    if (
      !target ||
      link.profileId !== target.profileId ||
      this.identityLoading ||
      this.identityBusy ||
      this.channelIdentityLoading ||
      this.channelIdentityMutation
    ) {
      return;
    }
    const mutationId = ++this.channelIdentityMutationId;
    this.channelIdentityListRequestId += 1;
    let mutationStatus: string | null = null;
    let mutationError: string | null = null;
    this.channelIdentityMutation = {
      kind: "unlink",
      profileId: target.profileId,
      identity: link.identity,
    };
    this.channelIdentityError = null;
    this.channelIdentityStatus = null;
    this.publish();
    try {
      await target.client.request<UsersUnlinkChannelIdentityResult>("users.unlinkChannelIdentity", {
        profileId: target.profileId,
        identity: link.identity,
      });
      const currentTarget = await this.waitForCurrentChannelIdentityTarget(target);
      if (
        mutationId !== this.channelIdentityMutationId ||
        !currentTarget ||
        !this.isCurrentChannelIdentityTarget(currentTarget)
      ) {
        return;
      }
      if (this.channelIdentityLinks !== null) {
        this.channelIdentityLinks = this.channelIdentityLinks.filter(
          (candidate) => !sameChannelIdentity(candidate.identity, link.identity),
        );
      }
      mutationStatus = t("profilePage.channelIdentities.unlinked");
    } catch (error) {
      const currentTarget = await this.waitForCurrentChannelIdentityTarget(target);
      if (mutationId === this.channelIdentityMutationId && currentTarget) {
        mutationError = formatUiError(error, t("profilePage.channelIdentities.unlinkFailed"));
      }
    } finally {
      if (mutationId === this.channelIdentityMutationId && target.client === this.client) {
        const reloadTarget = this.currentChannelIdentityTarget();
        this.channelIdentityMutation = null;
        if (reloadTarget) {
          await this.loadChannelIdentityLinks();
        }
        if (
          mutationId === this.channelIdentityMutationId &&
          reloadTarget &&
          this.isCurrentChannelIdentityTarget(reloadTarget)
        ) {
          if (mutationStatus) {
            this.channelIdentityStatus = mutationStatus;
          }
          if (mutationError) {
            this.channelIdentityError = mutationError;
          }
          this.publish();
        }
      }
    }
  }

  private currentChannelIdentityTarget(): ChannelIdentityTarget | null {
    const profile = this.ownProfile;
    const client = this.client;
    if (
      !client ||
      !this.canManageChannelIdentities() ||
      !this.canRead ||
      !this.channelIdentityProfileReady ||
      !profile
    ) {
      return null;
    }
    return { client, profileId: profile.id, identityRequestId: this.identityRequestId };
  }

  private async waitForCurrentChannelIdentityTarget(
    target: ChannelIdentityTarget,
  ): Promise<ChannelIdentityTarget | null> {
    if (this.isCurrentChannelIdentityTarget(target)) {
      return target;
    }
    if (target.client !== this.client || this.ownProfile?.id !== target.profileId) {
      return null;
    }
    const requestId = this.identityRequestId;
    if (this.identityLoading) {
      await this.identityReceipt.result;
    }
    if (requestId !== this.identityRequestId) {
      return null;
    }
    const current = this.currentChannelIdentityTarget();
    return current?.client === target.client && current.profileId === target.profileId
      ? current
      : null;
  }

  private isCurrentChannelIdentityTarget(target: ChannelIdentityTarget) {
    const current = this.currentChannelIdentityTarget();
    return (
      current?.client === target.client &&
      current.profileId === target.profileId &&
      current.identityRequestId === target.identityRequestId
    );
  }

  private resetChannelIdentityState(targetChanged: boolean, retireMutation = false) {
    this.channelIdentityListRequestId += 1;
    this.channelIdentityLinks = null;
    this.channelIdentityLoading = false;
    this.channelIdentityError = null;
    this.channelIdentityStatus = null;
    if (targetChanged || retireMutation) {
      this.channelIdentityMutationId += 1;
      this.channelIdentityMutation = null;
    }
    if (targetChanged) {
      this.channelId = "";
      this.accountId = "";
      this.senderId = "";
    }
  }
}
