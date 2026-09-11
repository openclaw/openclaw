import { nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";
import { prefetchGitHubLink } from "./github-link-hovercard-registration.ts";
import { gitHubPreviewKey, parseGitHubLinkTarget } from "./github-link-target.ts";

const PREFETCH_LIMIT = 8;
const PREFETCH_DELAY_MS = 150;

class GitHubLinkPrefetchDirective extends AsyncDirective {
  private root: HTMLElement | undefined;
  private sessionKey: string | undefined;
  private active = false;
  private scanPending = false;
  private observer: IntersectionObserver | null = null;
  private mutations: MutationObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scope = new AbortController();
  private pendingKey: string | undefined;
  private readonly observed = new Map<HTMLAnchorElement, { key: string; visible: boolean }>();
  private readonly attempted = new Set<string>();

  render(_sessionKey: string, _active = true, _connected = true) {
    return nothing;
  }

  override update(
    part: ElementPart,
    [sessionKey, active = true, connected = true]: [string, boolean?, boolean?],
  ) {
    if (sessionKey !== this.sessionKey || !connected) {
      this.release();
      this.attempted.clear();
      this.sessionKey = sessionKey;
    }
    this.root = part.element instanceof HTMLElement ? part.element : undefined;
    this.active = active && connected;
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.handleVisibilityChange();
    return nothing;
  }

  protected override disconnected(): void {
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.release();
  }

  protected override reconnected(): void {
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.handleVisibilityChange();
  }

  private readonly handleVisibilityChange = () => {
    if (this.active && !document.hidden) {
      this.scheduleScan();
    } else {
      this.release();
    }
  };

  private release(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.mutations?.disconnect();
    this.mutations = null;
    this.observed.clear();
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
    return this.active && this.isConnected && Boolean(this.root?.isConnected) && !document.hidden;
  }

  private scheduleScan(): void {
    if (this.scanPending) {
      return;
    }
    this.scanPending = true;
    // Lit commits an element directive before its children; virtualized rows can
    // also change without updating this directive.
    queueMicrotask(() => {
      this.scanPending = false;
      if (this.canPrefetch() && this.attempted.size < PREFETCH_LIMIT) {
        this.scan();
      }
    });
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
      const target = parseGitHubLinkTarget(anchor.href);
      if (!root.contains(anchor) || !target || gitHubPreviewKey(target) !== key) {
        this.observer.unobserve(anchor);
        this.observed.delete(anchor);
      }
    }
    for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a.markdown-github-link[href]")) {
      const target = parseGitHubLinkTarget(anchor.href);
      if (!target || this.observed.has(anchor)) {
        continue;
      }
      const key = gitHubPreviewKey(target);
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
        await prefetchGitHubLink(anchor, scope.signal);
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

export const githubLinkPrefetch = directive(GitHubLinkPrefetchDirective);
