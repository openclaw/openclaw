import type { ApplicationContext } from "../../app/context.ts";
import { saveUserPreferences } from "../../app/user-prefs-cache.ts";
import {
  decodePalettePreference,
  PALETTE_PREFERENCE_KEY,
  type PaletteSessionPreference,
} from "./preferences.ts";

type Client = NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
type Owner = { client: Client; hello: object; gatewayUrl: string; profileId: string };
type PreferenceEvent = "loaded" | "changed";

// This owner writes only the palette key. Ordinary defaults, migration and
// accepted worktree-name consumption belong to DraftPreferenceState.
const owners = new WeakMap<Client, WeakMap<object, Map<string, PaletteIdentityPreferences>>>();

export function acquirePaletteIdentityPreferences(owner: Owner): PaletteIdentityPreferences {
  let handshakes = owners.get(owner.client);
  if (!handshakes) {
    handshakes = new WeakMap();
    owners.set(owner.client, handshakes);
  }
  let profiles = handshakes.get(owner.hello);
  if (!profiles) {
    profiles = new Map();
    handshakes.set(owner.hello, profiles);
  }
  const key = JSON.stringify([owner.gatewayUrl, owner.profileId]);
  let state = profiles.get(key);
  if (!state) {
    const entries = profiles;
    const created = new PaletteIdentityPreferences(owner, () => {
      if (entries.get(key) === created) {
        entries.delete(key);
      }
    });
    state = created;
    profiles.set(key, state);
  }
  return state;
}

export class PaletteIdentityPreferences {
  mode: "loading" | "remote" | "local" = "loading";
  palettePreference: PaletteSessionPreference | null = null;
  private readonly listeners = new Map<(event: PreferenceEvent) => void, () => boolean>();
  private readonly loading: Promise<void>;
  private writing: Promise<void> = Promise.resolve();
  private pendingWrites = 0;

  constructor(
    private readonly owner: Owner,
    private readonly release: () => void,
  ) {
    this.loading = this.load();
  }

  subscribe(listener: (event: PreferenceEvent) => void, isCurrent: () => boolean) {
    this.listeners.set(listener, isCurrent);
    return () => {
      this.listeners.delete(listener);
      this.releaseIfIdle();
    };
  }

  private releaseIfIdle() {
    // A remount must join an already dispatched write, not create a second queue.
    if (!this.listeners.size && !this.pendingWrites) {
      this.release();
    }
  }

  private hasCurrentBinding() {
    return [...this.listeners.values()].some((isCurrent) => isCurrent());
  }

  setPalettePreference(
    preference: PaletteSessionPreference | null,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    if (!isCurrent()) {
      return Promise.resolve(false);
    }
    const write = async () => {
      await this.loading;
      // The admitted intent belongs to this handshake, not its original view.
      // A current same-owner remount can finish it; a retired owner cannot.
      if (!this.hasCurrentBinding() || this.mode !== "remote") {
        return false;
      }
      try {
        const result = await saveUserPreferences(this.owner.client, {
          entries: { [PALETTE_PREFERENCE_KEY]: preference },
        });
        if (result.status !== "ok") {
          return false;
        }
        this.palettePreference = preference;
        this.publish("changed");
        return true;
      } catch {
        return false;
      }
    };
    this.pendingWrites += 1;
    const pending = this.writing.then(write, write);
    this.writing = pending.then(
      () => {},
      () => {},
    );
    return pending.finally(() => {
      this.pendingWrites -= 1;
      this.releaseIfIdle();
    });
  }

  private publish(event: PreferenceEvent) {
    for (const [listener, isCurrent] of this.listeners) {
      if (isCurrent()) {
        listener(event);
      }
    }
  }

  private async load() {
    try {
      const { loadUserPreferences } = await import("../../app/user-prefs-request.ts");
      if (!this.hasCurrentBinding()) {
        return;
      }
      const result = await loadUserPreferences(this.owner.client, this.owner.profileId);
      if (!this.hasCurrentBinding()) {
        return;
      }
      if (result.status !== "ok") {
        this.mode = "local";
        return;
      }
      this.palettePreference = decodePalettePreference(result.entries[PALETTE_PREFERENCE_KEY]);
      this.mode = "remote";
    } catch {
      this.mode = "local";
    } finally {
      this.publish("loaded");
    }
  }
}
