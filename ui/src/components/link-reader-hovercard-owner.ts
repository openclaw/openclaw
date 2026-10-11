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
  parsePreviewResponse,
  previewContextFor,
  type PreviewContext,
  type CacheEntry,
  renderLoading,
  renderPreview,
  renderPreviewError,
  type LinkPreview,
} from "./link-reader-preview.tsx";
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
import { createPortaledHovercard, PortaledHovercardController } from "./portaled-hovercard.ts";

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

  get pagePreviewContext() {
    return this.host.pagePreviewContext;
  }
  get claimedReaders() {
    return this.host.claimedReaders;
  }
  get client() {
    return this.host.client;
  }
  get agentId() {
    return this.host.agentId;
  }
  get readers() {
    return this.host.readers;
  }

  propertyChanged(key: keyof HovercardProperties): void {
    if (key === "previewSeeds") {
      this.seeds = {
        client: this.client,
        agentId: this.agentId,
        generation: this.client?.connectionGeneration,
        recoveryScope: this.client?.recoveryScope,
        previews: this.host.previewSeeds,
      };
    } else if (key === "pagePreviewContext") {
      this.watchPageContext();
    } else if (key === "claimedReaders") {
      this.retirePage();
    } else {
      if (key === "readers") {
        const previous = this.readerDescriptors;
        this.readerDescriptors = this.readers;
        if (
          previous.length === this.readers.length &&
          previous.every((reader, index) => reader === this.readers[index])
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
    this.stopGateway = this.pagePreviewContext?.gateway.subscribe(() => {
      this.retirePage();
      this.update();
    });
    const syncConfig = () => {
      if (this.client && !this.pagePreviewContext?.config.current.automaticallyFetchFavicons) {
        clearLinkPreviews(this.client);
      }
      this.retirePage();
      this.update();
    };
    this.stopConfig = this.pagePreviewContext?.config.subscribe(syncConfig);
    syncConfig();
  }

  private seeds: {
    client: GatewayBrowserClient | null;
    agentId: string | undefined;
    generation: number | undefined;
    recoveryScope: string | undefined;
    previews: readonly ControlUiLinkReaderPreview[];
  } | null = null;

  private seedPreview(target: LinkReaderTarget): LinkPreview | undefined {
    const seeds = this.seeds;
    if (
      !seeds ||
      seeds.client !== this.client ||
      seeds.agentId !== this.agentId ||
      seeds.generation !== this.client?.connectionGeneration ||
      seeds.recoveryScope !== this.client?.recoveryScope
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
    const context = this.client ? previewContextFor(this.client, this.agentId) : null;
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
      const target = resolveLinkReaderTarget(anchor.href, this.readers);
      const preview = target ? this.cachedPreview(target)?.preview : undefined;
      if (!preview?.badge) {
        delete anchor.dataset.linkReaderTone;
        anchor.removeAttribute("aria-description");
      } else {
        anchor.setAttribute("aria-description", preview.badge.label);
        anchor.dataset.linkReaderTone = preview.badge.tone;
      }
    }
  }

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
      !this.client?.connected ||
      !this.readers.includes(target.reader) ||
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
  private readonly hovercard = new PortaledHovercardController(() => this.close());
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
    if (request?.state === "pending") {
      const seed = this.seedPreview(target);
      if (this.hovercard.held) {
        if (seed) {
          this.show(anchor, seed, true);
        } else if (this.allowLoading && context?.succeeded) {
          this.show(anchor);
        }
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
    if (anchor) {
      this.activateFocusedAnchor(anchor);
    }
  };

  private activateFocusedAnchor(anchor: HTMLAnchorElement): void {
    const target = resolveHoverPreviewTarget(anchor, this);
    if (!target) {
      return;
    }
    this.activateFromBootstrap(anchor, target, "pointer", LINK_READER_HOVERCARD_OPEN_DELAY_MS);
  }

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
    const target = anchor ? resolveHoverPreviewTarget(anchor, this) : null;
    if (!anchor || !target) {
      return;
    }
    if (!target.reader && !anchor.matches(":focus-visible")) {
      return;
    }
    this.activateFromBootstrap(anchor, target, "focus", 0);
  };

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
      !this.client ||
      !this.readers.includes(target.reader) ||
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
    this.allowLoading = Boolean(context?.succeeded && !this.cachedPreview(target));
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
      card.addEventListener("pointerleave", this.handleCardPointerLeave);
      this.hovercard.markTrigger(anchor);
      this.hovercard.mount(anchor, card, "vertical", true, () => disposePreview(card));
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
    const current = resolveHoverPreviewTarget(page.anchor, this);
    return (
      this.host.isConnected &&
      this.page === page &&
      page.anchor.isConnected &&
      this.ownsAnchor(page.anchor) &&
      Boolean(current && !current.reader && current.href === page.href) &&
      canPreviewPages(this) &&
      this.client === page.client &&
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
    const client = this.client;
    if (!client || !canPreviewPages(this)) {
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

  private cachedPreview(target: LinkReaderTarget): CacheEntry | undefined {
    const cached = this.cache.get(linkReaderTargetKey(target));
    return cached && !cached.controller.signal.aborted && cached.expiresAt > Date.now()
      ? cached
      : undefined;
  }

  private loadPreview(
    target: LinkReaderTarget,
    signal: AbortSignal,
  ): Promise<ControlUiLinkReaderPreview> {
    const key = linkReaderTargetKey(target);
    const now = Date.now();
    const cached = this.cachedPreview(target);
    this.cache.delete(key);
    // Dismissal invalidates only that request, even before its rejection settles.
    if (cached) {
      this.cache.set(key, cached);
      return subscribeToSharedRequest(cached, {}, signal);
    }

    const controller = new AbortController();
    const client = this.client;
    const context = this.previewContext;
    const agentId = this.agentId;
    const load = async (): Promise<ControlUiLinkReaderPreview> => {
      const method = target.reader.linkReader.previewMethod;
      if (!client || !method || !this.readers.includes(target.reader)) {
        throw new Error("Link preview requires an available reader");
      }
      const response = await client.request<ControlUiLinkReaderPreview>(
        method,
        {
          ...(agentId ? { agentId } : {}),
          url: target.href,
        },
        { signal: controller.signal },
      );
      return parsePreviewResponse(target, response);
    };

    const entry: CacheEntry = {
      expiresAt: now + SUCCESS_CACHE_MS,
      controller,
      subscribers: new Set(),
      promise: load()
        .then((preview) => {
          if (
            !controller.signal.aborted &&
            this.cache.get(key) === entry &&
            client === this.client &&
            agentId === this.agentId &&
            client &&
            previewContextFor(client, agentId) === context
          ) {
            entry.preview = preview;
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
