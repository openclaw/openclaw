import type {
  UserProfile,
  UsersSetAvatarResult,
  UsersSetDisplayNameResult,
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

export type IdentityChange =
  | { kind: "display-name" }
  | { kind: "avatar"; file: File }
  | { kind: "git-coauthor" | "pr-attribution"; enabled: boolean };

export class ProfileState {
  private publishTarget?: () => void;
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
    const readAccessLost = nextConnected && this.canRead && !nextCanRead;
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
    if (identitySourceChanged || connectionChanged) {
      this.retirePresentation();
      this.identityRequestId += 1;
      this.identityScope = {};
      this.identityReceipt = { result: Promise.resolve() };
      this.identityLoading = false;
      this.identityBusy = null;
      this.identityError = null;
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
      this.ownProfile = profile;
      if (!profile) {
        return;
      }
      this.displayName = hasUnsavedDisplayName ? displayNameDraft : (profile.displayName ?? "");
      this.gitCoauthorEnabled = true;
      this.prAttributionEnabled = false;
      this.publish();
      // Consent belongs to the person, not to a display-primary GitHub account.
      const { loadUserPreferences } = await import("../../app/user-prefs-request.ts");
      if (requestId !== this.identityRequestId) {
        return;
      }
      const preferences = await loadUserPreferences(client, profile.id, {
        keys:
          profile.id === GATEWAY_OWNER_PROFILE_ID
            ? [PR_ATTRIBUTION_PREFERENCE_KEY]
            : [GIT_COAUTHOR_PREFERENCE_KEY, PR_ATTRIBUTION_PREFERENCE_KEY],
      });
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
    if (this.identityReady && !this.identityBusy && !this.identityLoading) {
      if (this.client) {
        invalidateUserPreferences(this.client);
      }
      this.loadIdentity();
    }
  }
}
