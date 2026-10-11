import { linkReaderHovercardBootstrap as bootstrap } from "./link-reader-hovercard-registration.ts";
import {
  prefetchLinkReader,
  previewTargetForAnchor,
  resolveLinkReaderPreviewClaim,
} from "./link-reader-prefetch-request.ts";
import {
  LINK_READER_HOVERCARD_PROVIDER_TAG,
  linkReaderTargetKey,
  type HoverPreviewOwner,
  type LinkReaderTarget,
} from "./link-reader-target.ts";

const PREFETCH_LIMIT = 8;
const PREFETCH_DELAY_MS = 150;
const SCAN_IDLE_TIMEOUT_MS = 500;

export class LinkReaderPrefetchOwner {
  constructor(private readonly connected: () => boolean) {}
  private root: HTMLElement | undefined;
  private provider: Element | null = null;
  private readonly handleCapabilities = () => {
    this.release();
    this.attempted.clear();
    this.scheduleScan();
  };
  private sessionKey: string | undefined;
  private active = false;
  hide(): void {
    this.active = false;
    this.release();
  }
  private cancelScan: (() => void) | undefined;
  private observer: IntersectionObserver | null = null;
  private mutations: MutationObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scope = new AbortController();
  private pendingKey: string | undefined;
  private readonly observed = new Map<HTMLAnchorElement, { key: string; visible: boolean }>();
  private readonly attempted = new Set<string>();
  private claimReaders: HoverPreviewOwner["readers"] | undefined;
  private readonly claims = new Map<string, LinkReaderTarget | null>();
  private readonly resolveClaim = (href: string, readers: HoverPreviewOwner["readers"]) => {
    // Only URL claims are memoized; DOM exclusions stay live on every scan.
    if (readers !== this.claimReaders) {
      this.claims.clear();
      this.claimReaders = readers;
    }
    let claim = this.claims.get(href);
    if (claim === undefined) {
      claim = resolveLinkReaderPreviewClaim(href, readers);
      this.claims.set(href, claim);
    }
    return claim;
  };

  update(
    root: HTMLElement | undefined,
    sessionKey: string,
    presented: boolean,
    connected: boolean,
  ): void {
    if (sessionKey !== this.sessionKey || !connected) {
      this.release();
      this.attempted.clear();
      this.sessionKey = sessionKey;
    }
    this.root = root;
    const provider = this.root?.closest(LINK_READER_HOVERCARD_PROVIDER_TAG) ?? null;
    if (provider !== this.provider) {
      this.provider?.removeEventListener(
        "link-reader-capabilities-changed",
        this.handleCapabilities,
      );
      this.provider = provider;
      if (this.connected()) {
        this.provider?.addEventListener(
          "link-reader-capabilities-changed",
          this.handleCapabilities,
        );
      }
      this.release();
      this.attempted.clear();
    }
    this.active = connected && presented;
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.handleVisibilityChange();
  }

  disconnect(): void {
    this.provider?.removeEventListener("link-reader-capabilities-changed", this.handleCapabilities);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.release();
  }

  connect(): void {
    this.provider?.addEventListener("link-reader-capabilities-changed", this.handleCapabilities);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.handleVisibilityChange();
  }

  private readonly handleVisibilityChange = () => {
    if (this.connected() && this.active && !document.hidden) {
      if (!this.mutations) {
        this.scheduleScan();
      }
    } else {
      this.release();
    }
  };

  private release(): void {
    this.cancelScan?.();
    this.cancelScan = undefined;
    this.observer?.disconnect();
    this.observer = null;
    this.mutations?.disconnect();
    this.mutations = null;
    this.observed.clear();
    this.claims.clear();
    this.claimReaders = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.scope.abort();
    this.scope = new AbortController();
    if (this.pendingKey) {
      this.attempted.delete(this.pendingKey);
    }
    this.pendingKey = undefined;
  }

  private canPrefetch(): boolean {
    return this.active && this.connected() && Boolean(this.root?.isConnected) && !document.hidden;
  }

  private scheduleScan(): void {
    if (this.cancelScan || this.attempted.size >= PREFETCH_LIMIT) {
      return;
    }
    // The caller can mount before its children. Discover links after paint;
    // the mutation observer owns subsequent row and href changes.
    const scan = () => {
      this.cancelScan = undefined;
      if (this.canPrefetch() && this.attempted.size < PREFETCH_LIMIT) {
        this.scan();
      }
    };
    if (typeof requestIdleCallback === "function") {
      const handle = requestIdleCallback(scan, { timeout: SCAN_IDLE_TIMEOUT_MS });
      this.cancelScan = () => cancelIdleCallback(handle);
    } else {
      const timer = setTimeout(scan, SCAN_IDLE_TIMEOUT_MS);
      this.cancelScan = () => clearTimeout(timer);
    }
  }

  private scan(): void {
    const root = this.root;
    // No eager fallback: lack of visibility observation must not fetch a transcript.
    if (!root || typeof IntersectionObserver === "undefined") {
      return;
    }
    if (!this.observer) {
      const observer = new IntersectionObserver((entries) => {
        if (this.observer !== observer || !this.canPrefetch()) {
          return;
        }
        for (const entry of entries) {
          if (!(entry.target instanceof HTMLAnchorElement)) {
            continue;
          }
          const candidate = this.observed.get(entry.target);
          if (candidate) {
            candidate.visible = entry.isIntersecting;
          }
        }
        this.schedulePrefetch();
      });
      this.observer = observer;
      this.mutations = new MutationObserver(() => this.scheduleScan());
      this.mutations.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["href"],
      });
    }
    for (const [anchor, { key }] of this.observed) {
      const provider = bootstrap.providerFor(anchor);
      const target = previewTargetForAnchor(anchor, provider, this.resolveClaim);
      if (!root.contains(anchor) || !target || linkReaderTargetKey(target) !== key) {
        this.observer.unobserve(anchor);
        this.observed.delete(anchor);
      }
    }
    for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      if (this.observed.has(anchor)) {
        continue;
      }
      const provider = bootstrap.providerFor(anchor);
      const target = previewTargetForAnchor(anchor, provider, this.resolveClaim);
      if (!target) {
        continue;
      }
      const key = linkReaderTargetKey(target);
      if (!this.attempted.has(key)) {
        this.observed.set(anchor, { key, visible: false });
        this.observer.observe(anchor);
      }
    }
  }

  private schedulePrefetch(): void {
    if (
      this.timer !== undefined ||
      this.pendingKey !== undefined ||
      !this.canPrefetch() ||
      this.attempted.size >= PREFETCH_LIMIT
    ) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.prefetchNext();
    }, PREFETCH_DELAY_MS);
  }

  private async prefetchNext(): Promise<void> {
    if (!this.canPrefetch()) {
      return;
    }
    // Select distinct previews from current visibility, not a capped anchor queue:
    // repeated links must not crowd out other items or retain an offscreen slot.
    for (const [anchor, { key, visible }] of this.observed) {
      if (!visible || !this.root?.contains(anchor) || this.attempted.has(key)) {
        continue;
      }
      this.attempted.add(key);
      const scope = this.scope;
      this.pendingKey = key;
      try {
        await prefetchLinkReader(anchor, scope.signal);
      } catch {
        // Hover still presents cached errors; speculative work never opens UI.
      } finally {
        if (scope === this.scope) {
          this.pendingKey = undefined;
          if (this.attempted.size >= PREFETCH_LIMIT) {
            this.release();
          } else {
            this.schedulePrefetch();
          }
        }
      }
      return;
    }
  }
}
