import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";

export const STALE_BUNDLE_IDLE_RELOAD_MS = 5 * 60 * 1_000;

const ACTIVITY_THROTTLE_MS = 1_000;

export function readGatewayVersionFromSnapshot(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }
  const presence = (snapshot as { presence?: unknown }).presence;
  if (!Array.isArray(presence)) {
    return null;
  }
  const gateway = presence.find(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      typeof (entry as { mode?: unknown }).mode === "string" &&
      (entry as { mode: string }).mode.trim().toLowerCase() === "gateway" &&
      (entry as { reason?: unknown }).reason === "self" &&
      typeof (entry as { version?: unknown }).version === "string" &&
      Boolean((entry as { version: string }).version.trim()),
  );
  const version = (gateway as { version?: unknown } | undefined)?.version;
  return typeof version === "string" && version.trim() ? version.trim() : null;
}

export function resolveStaleBundleGatewayVersion(
  gatewayVersion: string | null | undefined,
  bundleVersion: string | null | undefined = CONTROL_UI_BUILD_INFO.version,
): string | null {
  // The connected Gateway snapshot is canonical for this tab. Any release
  // inequality, including an older Gateway, means the loaded bundle is stale.
  const normalizedGatewayVersion = gatewayVersion?.trim() ?? "";
  const normalizedBundleVersion = bundleVersion?.trim() ?? "";
  if (
    !normalizedGatewayVersion ||
    !normalizedBundleVersion ||
    normalizedGatewayVersion === normalizedBundleVersion
  ) {
    return null;
  }
  return normalizedGatewayVersion;
}

type StaleBundleReloadControllerOptions = {
  idleMs?: number;
  now?: () => number;
  prepareReload: () => boolean;
  reload?: () => void;
};

export class StaleBundleReloadController {
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly prepareReload: () => boolean;
  private readonly reload: () => void;
  private staleGatewayVersion: string | null = null;
  private lastActivityAt = 0;
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;

  constructor(options: StaleBundleReloadControllerOptions) {
    this.idleMs = options.idleMs ?? STALE_BUNDLE_IDLE_RELOAD_MS;
    this.now = options.now ?? Date.now;
    this.prepareReload = options.prepareReload;
    this.reload = options.reload ?? (() => globalThis.location.reload());
  }

  update(staleGatewayVersion: string | null): void {
    if (staleGatewayVersion === this.staleGatewayVersion) {
      return;
    }
    this.stop();
    this.staleGatewayVersion = staleGatewayVersion;
    if (!staleGatewayVersion) {
      return;
    }
    this.lastActivityAt = this.now();
    window.addEventListener("pointerdown", this.handleActivity, { passive: true });
    window.addEventListener("pointermove", this.handlePointerMove, { passive: true });
    window.addEventListener("keydown", this.handleActivity, { passive: true });
    window.addEventListener("focus", this.handleActivity, { passive: true });
    window.addEventListener("blur", this.handleActivity, { passive: true });
    document.addEventListener("visibilitychange", this.handleActivity, { passive: true });
    this.schedule(this.idleMs);
  }

  stop(): void {
    this.clearTimer();
    window.removeEventListener("pointerdown", this.handleActivity);
    window.removeEventListener("pointermove", this.handlePointerMove);
    window.removeEventListener("keydown", this.handleActivity);
    window.removeEventListener("focus", this.handleActivity);
    window.removeEventListener("blur", this.handleActivity);
    document.removeEventListener("visibilitychange", this.handleActivity);
    this.staleGatewayVersion = null;
  }

  private readonly handleActivity = () => {
    if (!this.staleGatewayVersion) {
      return;
    }
    this.lastActivityAt = this.now();
    this.schedule(this.idleMs);
  };

  private readonly handlePointerMove = () => {
    if (this.now() - this.lastActivityAt >= ACTIVITY_THROTTLE_MS) {
      this.handleActivity();
    }
  };

  private schedule(delay: number): void {
    this.clearTimer();
    this.timer = globalThis.setTimeout(this.handleIdleTimer, delay);
  }

  private clearTimer(): void {
    if (this.timer === null) {
      return;
    }
    globalThis.clearTimeout(this.timer);
    this.timer = null;
  }

  private readonly handleIdleTimer = () => {
    this.timer = null;
    if (!this.staleGatewayVersion) {
      return;
    }
    const remaining = this.idleMs - (this.now() - this.lastActivityAt);
    if (remaining > 0) {
      this.schedule(remaining);
      return;
    }
    // A dismissed Tier-1 card does not disable this lossless idle refresh.
    // Foreground work always wins; blur/visibility activity starts a fresh idle window.
    if (document.visibilityState === "visible" && document.hasFocus()) {
      return;
    }
    if (!this.prepareReload()) {
      this.lastActivityAt = this.now();
      this.schedule(this.idleMs);
      return;
    }
    this.reload();
  };
}
