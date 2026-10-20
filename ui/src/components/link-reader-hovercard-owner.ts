import type {
  ControlUiLinkReaderDescriptor,
  ControlUiLinkReaderPreview,
} from "../../../src/shared/control-ui-link-reader.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { registerLinkReaderEnglish } from "../i18n/locales/en-link-reader.ts";
import { clearLinkPreviews, loadLinkPreview } from "../lib/link-preview.ts";
import { anchorFromNavigationEvent, composedParent } from "../lib/navigation-click.ts";
import { listen } from "../lib/reactive/listener.ts";
import "../styles/link-reader-hovercard.css";
import { linkReaderErrorMessage } from "./link-reader-error.ts";
import type {
  HovercardProperties,
  LinkReaderHovercardProvider,
} from "./link-reader-hovercard.types.ts";
import { renderPagePreview, type PageActivation } from "./link-reader-page-preview.tsx";
import { LinkReaderPreviewCache } from "./link-reader-preview-cache.ts";
import { disposePreview } from "./link-reader-preview-root.ts";
import {
  previewContextFor,
  type PreviewContext,
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

let nextHovercardId = 0;

export class HovercardOwner {
  private page: PageActivation | null = null;
  private readerDescriptors: readonly ControlUiLinkReaderDescriptor[] = EMPTY_LINK_READERS;
  private connected = false;
  private stopGateway?: () => void;
  private stopConfig?: () => void;
  private stopListeners?: () => void;

  constructor(
    private readonly host: LinkReaderHovercardProvider,
    private readonly providerClass: CustomElementConstructor,
  ) {
    this.previews = new LinkReaderPreviewCache(
      host,
      () => this.previewContext,
      () => this.syncInlineStates(),
    );
  }

  propertyChanged(key: keyof HovercardProperties): void {
    if (key === "previewSeeds") {
      this.seeds = {
        client: this.host.client,
        agentId: this.host.agentId,
        sessionKey: this.host.sessionKey,
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
    // Retire connection-bound reads before a replacement client can publish.
    this.stopGateway = this.host.pagePreviewContext?.gateway.subscribe(() => {
      this.retirePage();
      const page = this.page;
      if (
        page &&
        (page.generation !== page.client.connectionGeneration || page.controller.signal.aborted)
      ) {
        page.controller.abort();
        page.generation = page.client.connectionGeneration;
        if (page.client.connected) {
          page.controller = new AbortController();
          this.loadPage(page);
        }
      }
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
    // Fetch-policy changes retire cached previews and in-flight reads synchronously.
    this.stopConfig = this.host.pagePreviewContext?.config.subscribe(syncConfig);
    syncConfig();
  }

  private seeds: {
    client: GatewayBrowserClient | null;
    agentId: string | undefined;
    sessionKey: string | undefined;
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

  private readonly previews: LinkReaderPreviewCache;
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
    const context =
      this.host.client && !this.host.client.offlineRecoveryRetired
        ? previewContextFor(this.host.client, this.host.agentId)
        : null;
    if (context !== this.previewContext) {
      // Clearing cached facts also updates inline projections under this new context.
      this.previewContext = context;
      this.close();
      this.clearPreviews();
    }
    this.previews.syncGeneration();
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
      const preview = target ? this.previews.get(target)?.preview : undefined;
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
    const entry = this.previews.updateFromDocument(target, detail);
    if (this.activeTarget && linkReaderTargetKey(this.activeTarget) === key) {
      const pending = this.previewRequest;
      this.previewRequest = {
        controller: new AbortController(),
        generation: client?.connectionGeneration,
        state: "complete",
        preview: { ...entry.preview, ...this.activeTarget },
      };
      pending?.controller.abort();
    }
    this.update();
  };

  private readonly inlineObserver = new MutationObserver(() => this.syncInlineStates());

  private clearPreviews(): void {
    this.previews.clear();
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
    await this.previews.load(target, signal);
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
  private previewRequest: {
    controller: AbortController;
    generation: number | undefined;
    state: "pending" | "complete" | "error";
    preview?: LinkPreview;
    error?: unknown;
  } | null = null;

  private async requestPreview(target: LinkReaderTarget): Promise<void> {
    const client = this.host.client;
    const generation = client?.connectionGeneration;
    const context = this.previewContext;
    const request = {
      controller: new AbortController(),
      generation,
      state: "pending" as const,
      preview: this.previewRequest?.preview,
    };
    this.previewRequest = request;
    this.update();
    try {
      const preview = await this.previews.load(target, request.controller.signal);
      if (
        this.previewRequest === request &&
        this.host.client === client &&
        client?.connectionGeneration === generation &&
        this.syncPreviewContext() === context
      ) {
        this.previewRequest = { ...request, state: "complete", preview: { ...preview, ...target } };
        this.update();
      }
    } catch (error: unknown) {
      if (
        this.previewRequest === request &&
        this.host.client === client &&
        client?.connectionGeneration === generation &&
        this.syncPreviewContext() === context
      ) {
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
    const stopListeners = [
      listen(window, LINK_READER_METADATA_UPDATED_EVENT, (event) => {
        if (event instanceof CustomEvent) {
          this.handleMetadataUpdate(event);
        }
      }),
      listen(this.host, "pointerover", this.handlePointerOver),
      listen(this.host, "pointerout", this.handlePointerOut),
      listen(this.host, "focusin", this.handleFocusIn),
      listen(this.host, "focusout", this.handleFocusOut),
      listen(this.host, "keydown", this.hovercard.handleTriggerKeyDown),
      listen(this.host, "click", this.handleClick),
    ];
    this.stopListeners = () => stopListeners.forEach((stop) => stop());
    this.host.style.display = "contents";
    this.inlineObserver.observe(this.host, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href"],
    });
    this.watchPageContext();
    // Restore focus intent after the bridge finishes adopting its caller's nodes.
    queueMicrotask(() => {
      const root = this.host.getRootNode();
      const focused =
        root instanceof ShadowRoot ? root.activeElement : this.host.ownerDocument.activeElement;
      if (this.connected && focused instanceof HTMLAnchorElement && this.ownsAnchor(focused)) {
        this.activateFocusedAnchor(focused);
      }
    });
  }

  disconnect(): void {
    this.connected = false;
    this.stopListeners?.();
    this.stopListeners = undefined;
    this.inlineObserver.disconnect();
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
    if (
      request &&
      this.host.client?.connected &&
      request.generation !== this.host.client.connectionGeneration
    ) {
      request.controller.abort();
      void this.requestPreview(target);
      return;
    }
    if (request?.state === "pending") {
      const seed = request.preview ?? this.seedPreview(target);
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
      this.show(anchor, request.preview ?? this.seedPreview(target), true, () =>
        linkReaderErrorMessage(request.error),
      );
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
    this.allowLoading = Boolean(context?.succeeded && !this.previews.get(target));
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
    error?: () => string,
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
          this.loadPage(page);
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

  private loadPage(page: PageActivation): void {
    const generation = page.generation;
    void loadLinkPreview(page.client, page.href, page.controller.signal)
      .then((preview) => {
        if (this.currentPage(page) && page.client.connectionGeneration === generation) {
          page.preview = preview;
          this.showPage(page);
        }
      })
      .catch(() => {
        /* Dismissal releases only this presentation's subscription. */
      });
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
