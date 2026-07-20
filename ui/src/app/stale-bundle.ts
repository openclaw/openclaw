import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";
import { t } from "../i18n/index.ts";

const STALE_BUNDLE_IDLE_RELOAD_MS = 5 * 60 * 1_000;
const STALE_BUNDLE_AUTO_RELOAD_STORAGE_KEY = "openclaw:control-ui:stale-bundle-auto-reloaded:v1";

const ACTIVITY_THROTTLE_MS = 1_000;

export type StaleBundleVersionPair = Readonly<{
  bundleVersion: string;
  gatewayVersion: string;
}>;

export type StaleBundleReloadPreparation = "attachments" | "blocked" | "ready";

type StaleBundleReloadTarget = {
  prepareForStaleBundleReload: () => StaleBundleReloadPreparation;
};

type ComposerReloadGuardOptions = {
  confirmDiscardAttachments?: () => boolean;
  reload?: () => void;
  root?: ParentNode;
};

export function gatewayUrlMatchesDocumentOrigin(
  gatewayUrl: string,
  documentHref: string = globalThis.location.href,
): boolean {
  try {
    const documentUrl = new URL(documentHref);
    const gateway = new URL(gatewayUrl, documentUrl);
    if (gateway.protocol !== "ws:" && gateway.protocol !== "wss:") {
      return false;
    }
    gateway.protocol = gateway.protocol === "ws:" ? "http:" : "https:";
    return documentUrl.origin !== "null" && gateway.origin === documentUrl.origin;
  } catch {
    return false;
  }
}

export function resolveStaleBundleReloadPair(params: {
  bundleVersion?: string | null;
  documentHref?: string;
  gatewayUrl: string;
  gatewayVersion?: string | null;
}): StaleBundleVersionPair | null {
  const bundleVersion = (params.bundleVersion ?? CONTROL_UI_BUILD_INFO.version)?.trim() ?? "";
  const gatewayVersion = resolveStaleBundleGatewayVersion(params.gatewayVersion, bundleVersion);
  if (!gatewayVersion || !gatewayUrlMatchesDocumentOrigin(params.gatewayUrl, params.documentHref)) {
    return null;
  }
  return { bundleVersion, gatewayVersion };
}

function composerReloadTargets(root: ParentNode): StaleBundleReloadTarget[] {
  return [...root.querySelectorAll<HTMLElement>("openclaw-chat-pane")].filter(
    (element): element is HTMLElement & StaleBundleReloadTarget =>
      "prepareForStaleBundleReload" in element &&
      typeof element.prepareForStaleBundleReload === "function",
  );
}

function collectComposerReloadPreparation(root: ParentNode): Set<StaleBundleReloadPreparation> {
  return new Set(composerReloadTargets(root).map((target) => target.prepareForStaleBundleReload()));
}

function reloadDocument(): void {
  // Full-page reload stays private to the guarded manual path and the idle
  // controller, which runs the same composer probe without prompting.
  globalThis.location.reload();
}

export function prepareComposerForIdleReload(root: ParentNode = document): boolean {
  const results = collectComposerReloadPreparation(root);
  return !results.has("blocked") && !results.has("attachments");
}

export function reloadWithComposerGuard(options: ComposerReloadGuardOptions = {}): boolean {
  const results = collectComposerReloadPreparation(options.root ?? document);
  if (results.has("blocked")) {
    return false;
  }
  if (
    results.has("attachments") &&
    !(
      options.confirmDiscardAttachments ??
      (() => globalThis.confirm(t("chat.sidebar.discardAttachmentsForRefresh")))
    )()
  ) {
    return false;
  }
  (options.reload ?? reloadDocument)();
  return true;
}

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

function resolveStaleBundleGatewayVersion(
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
  storage?: Storage | null;
};

function safeSessionStorage(): Storage | null {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}

function versionPairKey(pair: StaleBundleVersionPair): string {
  return JSON.stringify([pair.bundleVersion, pair.gatewayVersion]);
}

export class StaleBundleReloadController {
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly prepareReload: () => boolean;
  private readonly reload: () => void;
  private readonly storage: Storage | null;
  private stalePairKey: string | null = null;
  private lastActivityAt = 0;
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;

  constructor(options: StaleBundleReloadControllerOptions) {
    this.idleMs = options.idleMs ?? STALE_BUNDLE_IDLE_RELOAD_MS;
    this.now = options.now ?? Date.now;
    this.prepareReload = options.prepareReload;
    // Unattended reload calls this only after prepareReload has accepted the
    // shared composer probe and the version-pair loop guard is durable.
    this.reload = options.reload ?? reloadDocument;
    this.storage = options.storage === undefined ? safeSessionStorage() : options.storage;
  }

  update(stalePair: StaleBundleVersionPair | null): void {
    const nextPairKey = stalePair ? versionPairKey(stalePair) : null;
    if (nextPairKey === this.stalePairKey) {
      return;
    }
    this.stop();
    if (!nextPairKey || this.readReloadedPairs().has(nextPairKey)) {
      return;
    }
    this.stalePairKey = nextPairKey;
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
    this.stalePairKey = null;
  }

  private readonly handleActivity = () => {
    if (!this.stalePairKey) {
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
    if (!this.stalePairKey) {
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
    if (!this.recordReloadedPair()) {
      return;
    }
    this.reload();
  };

  private readReloadedPairs(): Set<string> {
    try {
      const raw = this.storage?.getItem(STALE_BUNDLE_AUTO_RELOAD_STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      return new Set(
        Array.isArray(parsed)
          ? parsed.filter((entry): entry is string => typeof entry === "string")
          : [],
      );
    } catch {
      return new Set();
    }
  }

  private recordReloadedPair(): boolean {
    if (!this.storage || !this.stalePairKey) {
      return false;
    }
    try {
      const reloadedPairs = this.readReloadedPairs();
      if (reloadedPairs.has(this.stalePairKey)) {
        return false;
      }
      reloadedPairs.add(this.stalePairKey);
      this.storage.setItem(
        STALE_BUNDLE_AUTO_RELOAD_STORAGE_KEY,
        JSON.stringify([...reloadedPairs]),
      );
      return true;
    } catch {
      return false;
    }
  }
}
