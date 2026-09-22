import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import type { ReactiveControllerHost } from "lit";
import { getSafeLocalStorage } from "../local-storage.ts";
import type { SidebarEmptyGroupsMode } from "./app-sidebar-session-types.ts";

const STORAGE_PREFIX = "openclaw.control.sidebarEmptyGroups.v1:";
const LEGACY_STORAGE_KEY = "openclaw:sidebar:sessions:hide-empty-groups";

type PreferenceContext = {
  gateway: {
    connection: { gatewayUrl: string };
    connectionRevision: number;
    snapshot: { phase: string; selfUser?: { id: string } | null };
  };
};

/** Personal presentation only: filter transitions never persist an effective value. */
export class SidebarEmptyGroupsController {
  mode: SidebarEmptyGroupsMode = "filtering";
  private storageKey: string | null = null;
  private owner: {
    gateway: PreferenceContext["gateway"];
    revision: number;
    origin: string;
  } | null = null;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly getContext: () => PreferenceContext | undefined,
  ) {}

  set(mode: SidebarEmptyGroupsMode): void {
    // A menu rendered for a retired account must not write into its replacement.
    if (this.reconcile()) {
      this.host.requestUpdate();
      return;
    }
    this.mode = mode;
    try {
      if (this.storageKey) {
        getSafeLocalStorage()?.setItem(this.storageKey, mode);
      }
    } catch {
      // A blocked browser store must not prevent changing the current view.
    }
    this.host.requestUpdate();
  }

  /** Called before the sidebar caches its rendered sections, not after rendering. */
  reconcile(): boolean {
    const gateway = this.getContext()?.gateway;
    const origin = gateway ? gatewayOriginScope(gateway.connection.gatewayUrl) : "";
    const retired =
      !gateway ||
      gateway.snapshot.phase === "stopped" ||
      this.owner?.gateway !== gateway ||
      this.owner.revision !== gateway.connectionRevision ||
      this.owner.origin !== origin;
    let changed = false;
    if (retired) {
      changed = this.storageKey !== null;
      this.storageKey = null;
      this.mode = "filtering";
      this.owner =
        gateway && gateway.snapshot.phase !== "stopped"
          ? { gateway, revision: gateway.connectionRevision, origin }
          : null;
    }
    // Transport retries clear selfUser but keep the same connection revision.
    // Preserve that viewer until a new hello resolves identity; stop/credential
    // changes above retire it immediately.
    if (!gateway || gateway.snapshot.phase !== "connected") {
      return changed;
    }
    const userId = gateway.snapshot.selfUser?.id.trim();
    const key = `${STORAGE_PREFIX}${origin}:${userId ? `user:${encodeURIComponent(userId)}` : "browser"}`;
    if (key === this.storageKey) {
      return changed;
    }
    this.storageKey = key;
    this.mode = "filtering";
    try {
      const storage = getSafeLocalStorage();
      const stored = storage?.getItem(key);
      if (stored === "filtering" || stored === "always" || stored === "never") {
        this.mode = stored;
        return true;
      }
      // Adopt the old browser choice once, for the first resolved viewer only.
      // Leaving it as a fallback would copy that person's choice to every account.
      const legacy = storage?.getItem(LEGACY_STORAGE_KEY);
      if (stored == null && (legacy === "true" || legacy === "false")) {
        this.mode = legacy === "true" ? "always" : "filtering";
        storage?.setItem(key, this.mode);
        storage?.removeItem(LEGACY_STORAGE_KEY);
      }
    } catch {
      // Keep the resolved/default value when local persistence is unavailable.
    }
    return true;
  }
}
