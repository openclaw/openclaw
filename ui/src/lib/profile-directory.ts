import type {
  UserProfile,
  UsersListResult,
} from "../../../packages/gateway-protocol/src/schema/users.js";
import { buildControlUiUserAvatarPath } from "../../../src/gateway/control-ui-user-avatar-route.js";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { hasOperatorReadAccess } from "../app/operator-access.ts";
import { createGatewayConnectionLifecycle } from "./gateway-connection-lifecycle.ts";
import type { IdentityAvatarInput } from "./identity-avatar.ts";

const directories = new WeakMap<ApplicationGateway, ProfileDirectory>();

export function profileDirectory(gateway: ApplicationGateway): ProfileDirectory {
  let directory = directories.get(gateway);
  if (!directory) {
    directory = new ProfileDirectory(gateway);
    directories.set(gateway, directory);
  }
  return directory;
}

/** Uploads and email-backed Gravatar both resolve through the versioned profile route. */
export function profileAvatarUrl(profile: UserProfile | undefined): string | undefined {
  return profile?.hasAvatar || profile?.emails.length
    ? buildControlUiUserAvatarPath(profile.id, profile.updatedAt)
    : undefined;
}

class ProfileDirectory {
  private readonly connection;
  private readonly listeners = new Set<() => void>();
  private profiles = new Map<string, UserProfile>();
  private signature = "";
  private client;
  private presentationKey;
  private selfAvatar: string | undefined;
  private pending: Promise<void> | undefined;
  private stop: (() => void) | undefined;
  result: UsersListResult | undefined;
  error: unknown;

  constructor(private readonly gateway: ApplicationGateway) {
    this.client = gateway.snapshot.client;
    this.presentationKey = gatewayPresentationScope(gateway).key;
    this.connection = createGatewayConnectionLifecycle(gateway.snapshot);
    this.synchronize();
  }

  get loading() {
    return Boolean(this.pending);
  }

  private notify() {
    this.listeners.forEach((listener) => listener());
  }

  private synchronize() {
    const { snapshot } = this.gateway;
    const presentationKey = gatewayPresentationScope(this.gateway).key;
    const signature =
      snapshot.phase === "connected"
        ? JSON.stringify([
            presentationKey,
            snapshot.hello?.auth?.role,
            snapshot.hello?.auth?.scopes,
          ])
        : this.signature;
    const identityChanged =
      this.client !== snapshot.client ||
      signature !== this.signature ||
      presentationKey !== this.presentationKey;
    this.client = snapshot.client;
    this.presentationKey = presentationKey;
    const changed = this.connection.transition(snapshot) || identityChanged;
    if (changed) {
      this.signature = signature;
      this.connection.invalidate();
      this.pending = undefined;
      if (identityChanged) {
        this.result = undefined;
        this.error = undefined;
        this.profiles.clear();
      }
    }
    return changed;
  }

  get(id: string): UserProfile | undefined {
    this.synchronize();
    const visited = new Set<string>();
    let profile = this.profiles.get(id);
    while (profile?.mergedInto && !visited.has(profile.id)) {
      visited.add(profile.id);
      profile = this.profiles.get(profile.mergedInto);
    }
    return profile?.mergedInto ? undefined : profile;
  }

  avatarIdentity(identity: IdentityAvatarInput): IdentityAvatarInput {
    if (identity.identity?.type !== "profile") {
      return identity;
    }
    const self = this.gateway.snapshot.selfUser;
    return {
      ...identity,
      // Published presence/upload URLs can be newer than the cached directory.
      profileAvatarUrl:
        identity.profileAvatarUrl?.trim() ||
        (self?.identity?.id === identity.identity.id ? self.avatarUrl : undefined) ||
        profileAvatarUrl(this.get(identity.identity.id)),
    };
  }

  load = (refresh = false): Promise<void> => {
    this.synchronize();
    if (this.pending) {
      return this.pending;
    }
    const scope = this.connection.capture();
    if (
      !scope ||
      !hasOperatorReadAccess(this.gateway.snapshot.hello?.auth ?? null) ||
      (!refresh && (this.result || this.error))
    ) {
      return Promise.resolve();
    }
    this.error = undefined;
    const request = scope.client
      .request<UsersListResult>("users.list", {})
      .then((result) => {
        this.synchronize();
        if (this.connection.isCurrent(scope)) {
          this.profiles = new Map(result.profiles.map((profile) => [profile.id, profile]));
          this.result = result;
        }
      })
      .catch((error: unknown) => {
        this.synchronize();
        if (this.connection.isCurrent(scope)) {
          this.error = error;
        }
      })
      .finally(() => {
        if (this.pending === request) {
          this.pending = undefined;
          this.notify();
        }
      });
    this.pending = request;
    this.notify();
    return request;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.selfAvatar = this.gateway.snapshot.selfUser?.avatarUrl;
    // Avatars, person cards, and assignment menus share this authorized directory's Gateway lifetime.
    this.stop ??= this.gateway.subscribe(() => {
      const avatar = this.gateway.snapshot.selfUser?.avatarUrl;
      const avatarChanged = avatar !== this.selfAvatar;
      this.selfAvatar = avatar;
      if (this.synchronize()) {
        this.notify();
        void this.load(true);
      } else if (avatarChanged) {
        this.notify();
        if (this.result) {
          void this.load(true);
        }
      }
    });
    void this.load();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.stop?.();
        this.stop = undefined;
        this.connection.invalidate();
        this.pending = undefined;
        this.result = undefined;
        this.profiles.clear();
        this.error = undefined;
      }
    };
  };
}
