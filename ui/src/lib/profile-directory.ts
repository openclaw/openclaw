import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  UserProfile,
  UsersListResult,
} from "../../../packages/gateway-protocol/src/schema/users.js";
import { buildControlUiUserAvatarPath } from "../../../src/gateway/control-ui-user-avatar-route.js";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { hasOperatorReadAccess, hasOperatorSelfReadAccess } from "../app/operator-access.ts";
import {
  createGatewayConnectionLifecycle,
  type GatewayConnectionScope,
} from "./gateway-connection-lifecycle.ts";
import type { IdentityAvatarInput } from "./identity-avatar.ts";

export type ProfileRead =
  | { status: "ready"; profile: UserProfile }
  | { status: "unknown" | "loading" | "unavailable" | "denied" | "disconnected" };

const directories = new WeakMap<ApplicationGateway, ProfileDirectory>();

export function profileDirectory(gateway: ApplicationGateway): ProfileDirectory {
  let directory = directories.get(gateway);
  if (!directory) {
    directory = new ProfileDirectory(gateway);
    directories.set(gateway, directory);
  }
  return directory;
}

/** The Gateway route alone decides upload, provider, host-photo and initials fallback. */
export function profileAvatarUrl(profile: UserProfile | undefined): string | undefined {
  return profile ? buildControlUiUserAvatarPath(profile.id, profile.updatedAt) : undefined;
}

class ProfileDirectory {
  private readonly connection;
  private readonly listeners = new Set<() => void>();
  private readonly selfReaders = new Set<() => void>();
  private profiles = new Map<string, UserProfile>();
  private signature = "";
  private client;
  private hello;
  private presentationKey;
  private selfAvatar: string | undefined;
  private pending: Promise<void> | undefined;
  private acceptedScope: GatewayConnectionScope | undefined;
  private acceptedHello: ApplicationGateway["snapshot"]["hello"] = null;
  private stop: (() => void) | undefined;
  result: UsersListResult | undefined;
  error: unknown;

  constructor(private readonly gateway: ApplicationGateway) {
    this.client = gateway.snapshot.client;
    this.hello = gateway.snapshot.hello;
    this.presentationKey = gatewayPresentationScope(gateway).key;
    this.connection = createGatewayConnectionLifecycle(gateway.snapshot);
    this.synchronize();
  }

  get loading() {
    return Boolean(this.pending);
  }

  private currentRead() {
    return (
      this.acceptedScope !== undefined &&
      this.connection.isCurrent(this.acceptedScope) &&
      this.acceptedHello === this.gateway.snapshot.hello
    );
  }

  get currentResult() {
    this.synchronize();
    return this.currentRead() && !this.error ? this.result : undefined;
  }

  /** Avatars may retain cached identity through a blip; assignments need a current read. */
  readProfile(id: string): ProfileRead {
    this.synchronize();
    const { snapshot } = this.gateway;
    if (!this.connection.capture()) {
      return { status: "disconnected" };
    }
    if (
      !hasOperatorReadAccess(snapshot.hello?.auth ?? null) &&
      (!hasOperatorSelfReadAccess(snapshot.hello?.auth ?? null) ||
        snapshot.selfUser?.identity?.id !== id)
    ) {
      return { status: "denied" };
    }
    if (!this.currentRead()) {
      return { status: this.pending ? "loading" : "unknown" };
    }
    const profile = !this.error ? this.get(id) : undefined;
    return profile ? { status: "ready", profile } : { status: "unavailable" };
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
    const helloChanged = snapshot.phase === "connected" && this.hello !== snapshot.hello;
    this.client = snapshot.client;
    if (snapshot.phase === "connected") {
      this.hello = snapshot.hello;
    }
    this.presentationKey = presentationKey;
    const changed = this.connection.transition(snapshot) || identityChanged || helloChanged;
    if (changed) {
      this.signature = signature;
      this.connection.invalidate();
      this.pending = undefined;
      this.acceptedScope = undefined;
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
        profileAvatarUrl(this.get(identity.identity.id)) ||
        // Restricted readers can render an explicitly identified person without enumerating profiles.
        (!hasOperatorReadAccess(this.gateway.snapshot.hello?.auth ?? null)
          ? buildControlUiUserAvatarPath(identity.identity.id)
          : undefined),
    };
  }

  load = (refresh = false): Promise<void> => {
    this.synchronize();
    if (this.pending) {
      return this.pending;
    }
    const scope = this.connection.capture();
    const hello = this.gateway.snapshot.hello;
    const broad = hasOperatorReadAccess(hello?.auth ?? null);
    if (
      !scope ||
      (!broad && (!this.selfReaders.size || !hasOperatorSelfReadAccess(hello?.auth ?? null))) ||
      (!refresh && this.currentRead())
    ) {
      return Promise.resolve();
    }
    this.error = undefined;
    // Self reads retain the Gateway owner’s admission and in-flight coalescing.
    const read = broad
      ? scope.client.request<UsersListResult>("users.list", {})
      : this.gateway.loadSelfProfile().then((profile) => ({ profiles: profile ? [profile] : [] }));
    const request = read
      .then((result) => {
        this.synchronize();
        if (this.connection.isCurrent(scope) && this.gateway.snapshot.hello === hello) {
          this.profiles = new Map(result.profiles.map((profile) => [profile.id, profile]));
          this.result = broad ? result : undefined;
          this.acceptedScope = scope;
          this.acceptedHello = hello;
        }
      })
      .catch((error: unknown) => {
        this.synchronize();
        if (this.connection.isCurrent(scope) && this.gateway.snapshot.hello === hello) {
          this.error = error;
          this.acceptedScope = scope;
          this.acceptedHello = hello;
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

  subscribe = (listener: () => void, includeSelf = false): (() => void) => {
    this.listeners.add(listener);
    if (includeSelf) {
      this.selfReaders.add(listener);
    }
    this.selfAvatar = this.gateway.snapshot.selfUser?.avatarUrl;
    // Avatars, person cards, and assignment menus share this authorized directory's Gateway lifetime.
    if (!this.stop) {
      const stopGateway = this.gateway.subscribe(() => {
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
      const stopEvents = this.gateway.subscribeEvents((event) => {
        if (
          event.event !== "sessions.changed" ||
          asOptionalRecord(event.payload)?.reason !== "profile-identity"
        ) {
          return;
        }
        // Role/merge facts changed: an older in-flight directory cannot restore them.
        this.connection.invalidate();
        this.pending = undefined;
        this.acceptedScope = undefined;
        this.result = undefined;
        this.profiles.clear();
        this.notify();
        void this.load(true);
      });
      this.stop = () => {
        stopGateway();
        stopEvents();
      };
    }
    void this.load();
    return () => {
      this.listeners.delete(listener);
      this.selfReaders.delete(listener);
      if (
        this.listeners.size &&
        includeSelf &&
        !this.selfReaders.size &&
        !hasOperatorReadAccess(this.gateway.snapshot.hello?.auth ?? null)
      ) {
        // An avatar observer does not retain a closed guest card’s private profile read.
        this.connection.invalidate();
        this.pending = undefined;
        this.acceptedScope = undefined;
        this.profiles.clear();
        this.error = undefined;
      }
      if (!this.listeners.size) {
        this.stop?.();
        this.stop = undefined;
        this.connection.invalidate();
        this.pending = undefined;
        this.acceptedScope = undefined;
        this.result = undefined;
        this.profiles.clear();
        this.error = undefined;
      }
    };
  };
}
