import { pruneMapToMaxSize } from "../../../src/infra/map-size.ts";
import type {
  ControlUiLinkReaderDescriptor,
  ControlUiLinkReaderPreview,
} from "../../../src/shared/control-ui-link-reader.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { i18n } from "../i18n/index.ts";
import { registerLinkReaderEnglish } from "../i18n/locales/en-link-reader.ts";
import { clearLinkPreviews, loadLinkPreview } from "../lib/link-preview.ts";
import { anchorFromNavigationEvent, composedParent } from "../lib/navigation-click.ts";
import { listen } from "../lib/reactive/listener.ts";
import { subscribeToSharedRequest } from "../lib/shared-request-subscription.ts";
import "../styles/link-reader-hovercard.css";
import { linkReaderErrorMessage } from "./link-reader-error.ts";
import type {
  HovercardProperties,
  LinkReaderHovercardProvider,
} from "./link-reader-hovercard.types.ts";
import { renderPagePreview, type PageActivation } from "./link-reader-page-preview.tsx";
import { disposePreview } from "./link-reader-preview-root.ts";
import {
  cacheEntryFromDocument,
  cachedReaderPreview,
  requestReaderPreview,
  previewContextFor,
  type PreviewContext,
  type CacheEntry,
  renderLoading,
  renderPreview,
  renderPreviewError,
  type LinkPreview,
} from "./link-reader-preview.tsx";
import {
  LINK_READER_METADATA_UPDATED_EVENT,
  type LinkReaderMetadataUpdate,
} from "./link-reader-response.ts";
import {
  LINK_READER_HOVERCARD_OPEN_DELAY_MS,
  resolveLinkReaderTarget,
  linkReaderTargetKey,
  EMPTY_LINK_READERS,
  resolveHoverPreviewTarget,
  canPreviewPages,
  type HoverPreviewTarget,
  type PageHoverTarget,
  type LinkReaderTarget,
} from "./link-reader-target.ts";
import { createPortaledHovercard, createPortaledHovercardOwner } from "./portaled-hovercard.ts";

registerLinkReaderEnglish();

const SUCCESS_CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 30_000;
const CACHE_LIMIT = 100;

let nextHovercardId = 0;

export class HovercardOwner {
  private page: PageActivation | null = null;
  private readerDescriptors: readonly ControlUiLinkReaderDescriptor[] = EMPTY_LINK_READERS;
  private connected = false;
  private stopGateway?: () => void;
  private stopConfig?: () => void;

  constructor(
    private readonly host: LinkReaderHovercardProvider,
    private readonly providerClass: CustomElementConstructor,
  ) {}

  propertyChanged(key: keyof HovercardProperties): void {
    if (key === "previewSeeds") {
      this.seeds = {
        client: this.host.client,
        agentId: this.host.agentId,
        sessionKey: this.host.sessionKey,
        generation: this.host.client?.connectionGeneration,
        recoveryScope: this.host.client?.recoveryScope,
        previews: this.host.previewSeeds,
      };
    } else if (key === "pagePreviewContext") {
      this.watchPageContext();
    } else if (key === "claimedReaders") {
      this.retirePage();
    } else {
      if (key === "readers") {
        const previous = this.readerDescriptors;
        this.readerDescriptors = this.host.readers;
        if (
          previous.length === this.host.readers.length &&
          previous.every((reader, index) => reader === this.host.readers[index])
        ) {
          return;
        }
      }
      this.invalidatePreviewContext();
      this.host.dispatchEvent(new Event("link-reader-capabilities-changed"));
    }
    this.update();
  }

  private watchPageContext(): void {
    if (!this.connected) {
      return;
    }
    this.stopGateway?.();
    this.stopConfig?.();
    this.stopGateway = this.host.pagePreviewContext?.gateway.subscribe(() => {
      this.retirePage();
      this.update();
    });
    const syncConfig = () => {
      if (
        this.host.client &&
        !this.host.pagePreviewContext?.config.current.automaticallyFetchFavicons
      ) {
        clearLinkPreviews(this.host.client);
      }
      this.retirePage();
      this.update();
    };
    this.stopConfig = this.host.pagePreviewContext?.config.subscribe(syncConfig);
    syncConfig();
  }

  private seeds: {
    client: GatewayBrowserClient | null;
    agentId: string | undefined;
    sessionKey: string | undefined;
    generation: number | undefined;
    recoveryScope: string | undefined;
    previews: readonly ControlUiLinkReaderPreview[];
  } | null = null;

  private seedPreview(target: LinkReaderTarget): LinkPreview | undefined {
    const seeds = this.seeds;
    if (
      !seeds ||
      seeds.client !== this.host.client ||
      seeds.agentId !== this.host.agentId ||
      seeds.sessionKey !== this.host.sessionKey ||
      seeds.generation !== this.host.client?.connectionGeneration ||
      seeds.recoveryScope !== this.host.client?.recoveryScope
    ) {
      return undefined;
    }
    const seed = seeds.previews.find((preview) => {
      const seedTarget = resolveLinkReaderTarget(preview.url, [target.reader]);
      return seedTarget && linkReaderTargetKey(seedTarget) === linkReaderTargetKey(target);
    });
    return seed ? { ...seed, ...target } : undefined;
  }

  private readonly cache = new Map<string, CacheEntry>();
  private previewContext: PreviewContext | null = null;
  private allowLoading = false;
  private requestStarted = false;

  private invalidatePreviewContext(): void {
    this.seeds = null;
    this.previewContext = null;
    this.close();
    this.clearPreviews();
  }

  private syncPreviewContext(): PreviewContext | null {
    const context = this.host.client
      ? previewContextFor(this.host.client, this.host.agentId)
      : null;
    if (context !== this.previewContext) {
      // Clearing cached facts also updates inline projections under this new context.
      this.previewContext = context;
      this.close();
      this.clearPreviews();
    }
    return context;
  }
  private syncInlineStates(): void {
    this.syncPreviewContext();
    for (const anchor of this.host.querySelectorAll<HTMLAnchorElement>("a.markdown-github-item")) {
      // Nested providers retain their own agent and connection identity.
      if (!this.ownsAnchor(anchor)) {
        continue;
      }
      const target = resolveLinkReaderTarget(anchor.href, this.host.readers);
      const preview = target ? cachedReaderPreview(this.cache, target)?.preview : undefined;
      if (!preview?.badge) {
        delete anchor.dataset.linkReaderTone;
        anchor.removeAttribute("aria-description");
      } else {
        anchor.setAttribute("aria-description", preview.badge.label);
        anchor.dataset.linkReaderTone = preview.badge.tone;
      }
    }
  }

  private readonly handleMetadataUpdate = (event: CustomEvent<LinkReaderMetadataUpdate>) => {
    const { client, agentId, sessionKey, target, preview: detail } = event.detail;
    if (
      client !== this.host.client ||
      agentId !== this.host.agentId ||
      (sessionKey ?? "") !== (this.host.sessionKey ?? "") ||
      !this.host.readers.includes(target.reader)
    ) {
      return;
    }
    this.syncPreviewContext();
    const key = linkReaderTargetKey(target);
    const previous = this.cache.get(key);
    const entry = cacheEntryFromDocument(target, detail, previous, Date.now() + SUCCESS_CACHE_MS);
    this.cache.set(key, entry);
    if (this.activeTarget && linkReaderTargetKey(this.activeTarget) === key) {
      const pending = this.previewRequest;
      this.previewRequest = {
        controller: new AbortController(),
        state: "complete",
        preview: { ...entry.preview, ...this.activeTarget },
      };
      pending?.controller.abort();
    }
    previous?.controller.abort();
    pruneMapToMaxSize(this.cache, CACHE_LIMIT);
    this.update();
  };

  private readonly inlineObserver = new MutationObserver(() => this.syncInlineStates());

  private clearPreviews(): void {
    for (const entry of this.cache.values()) {
      entry.controller.abort();
    }
    this.cache.clear();
    this.syncInlineStates();
  }

  async prefetch(target: LinkReaderTarget, signal: AbortSignal): Promise<void> {
    if (
      !this.host.isConnected ||
      !this.host.client?.connected ||
      !this.host.readers.includes(target.reader) ||
      !target.reader.linkReader.previewMethod ||
      signal.aborted
    ) {
      return;
    }
    this.syncPreviewContext();
    await this.loadPreview(target, signal);
    if (!signal.aborted) {
      this.syncInlineStates();
    }
  }

  private activeAnchor: HTMLAnchorElement | null = null;
  private activeTarget: LinkReaderTarget | null = null;
  // Which surface opened the current card: gates whether focus landing inside
  // the portaled card (e.g. clicking the title link) can hold it open, so a
  // pointer-driven open still fully releases on mouse-out (see handleCardPointerLeave).
  private activeTrigger: "focus" | "pointer" | null = null;
  private readonly hovercard = createPortaledHovercardOwner(() => this.close());
  private stopI18n: (() => void) | null = null;
  private previewRequest: {
    controller: AbortController;
    state: "pending" | "complete" | "error";
    preview?: LinkPreview;
    error?: unknown;
  } | null = null;

  private async requestPreview(target: LinkReaderTarget): Promise<void> {
    const request = { controller: new AbortController(), state: "pending" as const };
    this.previewRequest = request;
    this.update();
    try {
      const preview = await this.loadPreview(target, request.controller.signal);
      if (this.previewRequest === request) {
        this.previewRequest = { ...request, state: "complete", preview: { ...preview, ...target } };
        this.update();
      }
    } catch (error) {
      if (this.previewRequest === request) {
        this.previewRequest = { ...request, state: "error", error };
        this.update();
      }
    }
  }
  private readonly activeAnchorObserver = new MutationObserver(() => {
    if (this.page) {
      this.retirePage();
      return;
    }
    const anchor = this.activeAnchor;
    // The card is portaled outside the routed tree, whose replacement can remove
    // a hovered link without a pointer event reaching this delegated handler.
    if (anchor && (!this.ownsAnchor(anchor) || anchor.href !== this.activeTarget?.href)) {
      this.close();
    }
  });

  connect(): void {
    this.connected = true;
    window.addEventListener(LINK_READER_METADATA_UPDATED_EVENT, this.handleMetadataUpdate);
    this.host.style.display = "contents";
    this.inlineObserver.observe(this.host, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href"],
    });
    this.host.addEventListener("pointerover", this.handlePointerOver);
    this.host.addEventListener("pointerout", this.handlePointerOut);
    this.host.addEventListener("focusin", this.handleFocusIn);
    this.host.addEventListener("focusout", this.handleFocusOut);
    this.host.addEventListener("keydown", this.hovercard.handleTriggerKeyDown);
    this.host.addEventListener("click", this.handleClick);
    this.stopI18n ??= i18n.subscribe(() => this.update());
    this.watchPageContext();
    // Restore focus intent after the bridge finishes adopting its caller's nodes.
    queueMicrotask(() => {
      const focused = this.connected ? this.host.querySelector<HTMLAnchorElement>("a:focus") : null;
      if (focused && this.ownsAnchor(focused)) {
        this.activateFocusedAnchor(focused);
      }
    });
  }

  disconnect(): void {
    this.connected = false;
    window.removeEventListener(LINK_READER_METADATA_UPDATED_EVENT, this.handleMetadataUpdate);
    this.host.removeEventListener("pointerover", this.handlePointerOver);
    this.host.removeEventListener("pointerout", this.handlePointerOut);
    this.host.removeEventListener("focusin", this.handleFocusIn);
    this.host.removeEventListener("focusout", this.handleFocusOut);
    this.host.removeEventListener("keydown", this.hovercard.handleTriggerKeyDown);
    this.host.removeEventListener("click", this.handleClick);
    this.inlineObserver.disconnect();
    this.stopI18n?.();
    this.stopI18n = null;
    this.close();
    this.clearPreviews();
    this.stopGateway?.();
    this.stopConfig?.();
  }

  private update(): void {
    const context = this.syncPreviewContext();
    this.syncInlineStates();
    if (this.page) {
      this.retirePage();
      if (this.page && this.hovercard.card) {
        this.showPage(this.page);
      }
      return;
    }
    const anchor = this.activeAnchor;
    const target = this.activeTarget;
    if (!anchor || !target || !this.requestStarted) {
      return;
    }
    if (!this.host.isConnected || !this.ownsAnchor(anchor) || anchor.href !== target.href) {
      this.close();
      return;
    }
    const request = this.previewRequest;
    if (request?.state === "pending" && this.hovercard.held) {
      const seed = this.seedPreview(target);
      if (seed) {
        this.show(anchor, seed, true);
      } else if (this.allowLoading && context?.succeeded) {
        this.show(anchor);
      }
    } else if (request?.state === "complete" && request.preview) {
      if (request.preview.href === target.href && (this.hovercard.card || this.hovercard.held)) {
        this.show(anchor, request.preview);
      }
    } else if (request?.state === "error" && (this.hovercard.card || this.hovercard.held)) {
      this.show(anchor, this.seedPreview(target), true, linkReaderErrorMessage(request.error));
    }
  }

  private readonly handlePointerOver = (event: PointerEvent) => {
    if (event.pointerType === "touch") {
      return;
    }
    const anchor = anchorFromNavigationEvent(event);
    const target = anchor ? resolveHoverPreviewTarget(anchor, this.host) : null;
    if (!anchor || !target) {
      return;
    }
    this.activateFromBootstrap(anchor, target, "pointer", LINK_READER_HOVERCARD_OPEN_DELAY_MS);
  };

  private readonly handlePointerOut = (event: PointerEvent) => {
    const anchor = anchorFromNavigationEvent(event);
    if (!anchor || anchor !== this.activeAnchor) {
      return;
    }
    if (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget)) {
      return;
    }
    if (this.page) {
      this.hovercard.schedulePointerExit();
      return;
    }
    this.hovercard.pointerInside = false;
    this.scheduleIntentClose();
  };

  private scheduleIntentClose(): void {
    if (this.previewRequest?.state === "pending" && !this.hovercard.held) {
      this.close();
    } else {
      this.hovercard.scheduleClose();
    }
  }

  private readonly handleCardPointerLeave = () => {
    this.hovercard.pointerOverCard = false;
    // A pointer-opened card must release fully on mouse-out even if a click
    // inside the card (e.g. the title link) left it focused; otherwise it
    // would stay stuck open with nothing left driving the intent.
    if (this.activeTrigger === "pointer") {
      this.hovercard.cardFocusInside = false;
    }
    this.hovercard.scheduleClose();
  };

  private readonly handleFocusIn = (event: Event) => {
    if (this.hovercard.restoringFocus) {
      return;
    }
    const anchor = anchorFromNavigationEvent(event);
    if (anchor) {
      this.activateFocusedAnchor(anchor);
    }
  };

  private activateFocusedAnchor(anchor: HTMLAnchorElement): void {
    const target = resolveHoverPreviewTarget(anchor, this.host);
    if (!target) {
      return;
    }
    if (!target.reader && !anchor.matches(":focus-visible")) {
      return;
    }
    this.activateFromBootstrap(anchor, target, "focus", 0);
  }

  private readonly handleFocusOut = (event: FocusEvent) => {
    if (!this.activeAnchor) {
      return;
    }
    if (event.relatedTarget instanceof Node && this.activeAnchor.contains(event.relatedTarget)) {
      return;
    }
    this.hovercard.focusInside = false;
    this.scheduleIntentClose();
  };

  private readonly handleClick = () => {
    this.close();
  };

  activateFromBootstrap(
    anchor: HTMLAnchorElement,
    target: HoverPreviewTarget,
    trigger: "focus" | "pointer",
    delay: number,
  ): void {
    // Nested providers retain their own agent scope when intent bubbles.
    if (!this.ownsAnchor(anchor)) {
      return;
    }
    if (!target.reader) {
      this.activatePage(anchor, target, trigger, delay);
      return;
    }
    if (
      !this.host.client ||
      !this.host.readers.includes(target.reader) ||
      !target.reader.linkReader.previewMethod
    ) {
      return;
    }
    this.activate(anchor, target, delay);
    this.activeTrigger = trigger;
    if (trigger === "pointer") {
      this.hovercard.pointerInside = true;
    } else {
      this.hovercard.focusInside = true;
    }
  }

  private activate(anchor: HTMLAnchorElement, target: LinkReaderTarget, delay: number): void {
    const context = this.syncPreviewContext();
    if (anchor === this.activeAnchor && this.activeTarget?.href === target.href) {
      return;
    }
    this.close();
    this.allowLoading = Boolean(context?.succeeded && !cachedReaderPreview(this.cache, target));
    this.activeAnchor = anchor;
    this.activeTarget = target;
    this.activeAnchorObserver.observe(this.host, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href"],
    });
    // Unseeded links stay quiet while this identity's first request is pending.
    this.hovercard.scheduleOpen(
      delay,
      () => {
        if (this.syncPreviewContext() !== context) {
          return;
        }
        this.requestStarted = true;
        const seed = this.seedPreview(target);
        if (seed) {
          this.show(anchor, seed, true);
        }
        void this.requestPreview(target);
      },
      anchor,
    );
  }

  private show(
    anchor: HTMLAnchorElement,
    preview?: LinkPreview,
    seeded = false,
    error?: string,
  ): void {
    const existing = this.hovercard.card;
    const card =
      existing ??
      createPortaledHovercard(
        "openclaw-link-reader-hovercard-" + ++nextHovercardId,
        "link-reader-hovercard",
      );
    if (preview) {
      renderPreview(card, preview, seeded, error, this.positionPreview);
    } else if (error && this.activeTarget) {
      renderPreviewError(card, this.activeTarget, error, this.positionPreview);
    } else {
      renderLoading(card, this.positionPreview);
    }
    this.mountPreview(anchor, card, Boolean(existing));
    if (preview && !seeded && this.previewContext) {
      this.previewContext.succeeded = true;
    }
  }

  private readonly positionPreview = () => this.hovercard.position();

  private mountPreview(anchor: HTMLAnchorElement, card: HTMLDivElement, existing: boolean): void {
    if (existing) {
      this.hovercard.position();
    } else {
      const stopPointerLeave = listen(card, "pointerleave", this.handleCardPointerLeave);
      this.hovercard.markTrigger(anchor);
      this.hovercard.mount(anchor, card, "vertical", true, () => {
        stopPointerLeave();
        disposePreview(card);
      });
    }
  }

  private ownsAnchor(anchor: HTMLAnchorElement): boolean {
    let owner = composedParent(anchor);
    while (owner && !(owner instanceof this.providerClass)) {
      owner = composedParent(owner);
    }
    return owner === this.host;
  }

  private currentPage(page: PageActivation): boolean {
    const current = resolveHoverPreviewTarget(page.anchor, this.host);
    return (
      this.host.isConnected &&
      this.page === page &&
      page.anchor.isConnected &&
      this.ownsAnchor(page.anchor) &&
      Boolean(current && !current.reader && current.href === page.href) &&
      canPreviewPages(this.host) &&
      this.host.client === page.client &&
      page.client.connectionGeneration === page.generation &&
      page.client.recoveryScope === page.recoveryScope
    );
  }

  private retirePage(): void {
    if (this.page && !this.currentPage(this.page)) {
      this.close();
    }
  }

  private activatePage(
    anchor: HTMLAnchorElement,
    target: PageHoverTarget,
    trigger: "focus" | "pointer",
    delay: number,
  ): void {
    const client = this.host.client;
    if (!client || !canPreviewPages(this.host)) {
      return;
    }
    this.syncPreviewContext();
    this.retirePage();
    if (this.page?.anchor !== anchor || this.page.href !== target.href) {
      this.close();
      const page: PageActivation = {
        anchor,
        href: target.href,
        client,
        generation: client.connectionGeneration,
        recoveryScope: client.recoveryScope,
        controller: new AbortController(),
        preview: {},
        failedImages: new Set(),
      };
      this.page = page;
      this.activeAnchor = anchor;
      this.activeAnchorObserver.observe(this.host, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          "href",
          "download",
          "data-file-path",
          "data-session-href",
          "data-link-reader-external",
          "class",
          "hidden",
        ],
      });
      const root = anchor.getRootNode();
      if (root instanceof ShadowRoot) {
        this.activeAnchorObserver.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
        });
      }
      this.hovercard.scheduleOpen(
        delay,
        () => {
          if (!this.currentPage(page)) {
            this.close();
            return;
          }
          this.showPage(page);
          void loadLinkPreview(client, page.href, page.controller.signal)
            .then((preview) => {
              if (this.currentPage(page)) {
                page.preview = preview;
                this.showPage(page);
              }
            })
            .catch(() => {
              /* Dismissal releases only this presentation's subscription. */
            });
        },
        anchor,
      );
    }
    this.activeTrigger = trigger;
    if (trigger === "pointer") {
      this.hovercard.pointerInside = true;
    } else {
      this.hovercard.focusInside = true;
    }
    this.hovercard.clearClose();
  }

  private showPage(page: PageActivation): void {
    const existing = this.hovercard.card;
    const card =
      existing ??
      createPortaledHovercard("openclaw-link-preview-" + ++nextHovercardId, "link-hovercard");
    renderPagePreview(
      card,
      page.href,
      page.anchor.textContent?.trim() ?? "",
      page.preview,
      page.failedImages,
      (src) => {
        if (this.currentPage(page)) {
          page.failedImages.add(src);
          this.showPage(page);
        }
      },
      () => this.hovercard.position(),
    );
    this.mountPreview(page.anchor, card, Boolean(existing));
    // Anonymous page metadata never unlocks plugin success-dependent loaders.
  }

  private loadPreview(
    target: LinkReaderTarget,
    signal: AbortSignal,
  ): Promise<ControlUiLinkReaderPreview> {
    const key = linkReaderTargetKey(target);
    // Backoff expires request reuse, not the last-known facts retained for failed retries.
    const previous = this.cache.get(key);
    const cached = cachedReaderPreview(this.cache, target);
    this.cache.delete(key);
    // Dismissal invalidates only that request, even before its rejection settles.
    if (cached && (cached.enrichment !== "needed" || cached.preview?.stale)) {
      this.cache.set(key, cached);
      return subscribeToSharedRequest(cached, {}, signal);
    }

    const controller = new AbortController();
    const { client, agentId, sessionKey } = this.host;
    const scope = { client, agentId, sessionKey };
    const isCurrent = () =>
      client !== null &&
      !controller.signal.aborted &&
      client === this.host.client &&
      agentId === this.host.agentId &&
      sessionKey === this.host.sessionKey &&
      previewContextFor(client, agentId) === this.previewContext &&
      this.host.readers.includes(target.reader);
    const entry: CacheEntry = {
      enrichment: previous?.enrichment ? "pending" : undefined,
      preview: previous?.preview,
      expiresAt: Date.now() + SUCCESS_CACHE_MS,
      controller,
      subscribers: new Set(),
      promise: requestReaderPreview(scope, target, controller.signal, isCurrent, previous)
        .then((preview) => {
          if (isCurrent() && this.cache.get(key) === entry) {
            entry.preview = preview;
            entry.enrichment = preview.stale && previous?.enrichment ? "needed" : undefined;
            entry.expiresAt = Date.now() + (preview.stale ? FAILURE_CACHE_MS : SUCCESS_CACHE_MS);
            this.syncInlineStates();
          }
          return preview;
        })
        .catch((error: unknown) => {
          // Keep short-lived failures cached so repeatedly crossing a broken or
          // private link does not burn the service rate limit.
          entry.expiresAt = Date.now() + FAILURE_CACHE_MS;
          this.syncInlineStates();
          throw error;
        }),
    };
    this.cache.set(key, entry);
    this.syncInlineStates();
    pruneMapToMaxSize(this.cache, CACHE_LIMIT);
    // Each visible transcript or popup owns its subscription, not the shared fetch.
    return subscribeToSharedRequest(entry, {}, signal);
  }

  private close(): void {
    this.page?.controller.abort();
    this.page = null;
    this.requestStarted = false;
    this.allowLoading = false;
    this.hovercard.reset();
    this.activeAnchorObserver.disconnect();
    this.previewRequest?.controller.abort();
    this.previewRequest = null;
    this.activeAnchor = null;
    this.activeTarget = null;
    this.activeTrigger = null;
  }
}
