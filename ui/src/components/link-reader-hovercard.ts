import { initialState, Task, TaskStatus } from "@lit/task";
import { nothing, ReactiveElement, render } from "lit";
import type {
  ControlUiLinkReaderDescriptor,
  ControlUiLinkReaderPreview,
} from "../../../src/shared/control-ui-link-reader.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import { i18n } from "../i18n/index.ts";
import { registerLinkReaderEnglish } from "../i18n/locales/en-link-reader.ts";
import { clearLinkPreviews, loadLinkPreview } from "../lib/link-preview.ts";
import { anchorFromNavigationEvent, composedParent } from "../lib/navigation-click.ts";
import { subscribeToSharedRequest } from "../lib/shared-request-subscription.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import "../styles/link-reader-hovercard.css";
import { linkReaderErrorMessage } from "./link-reader-error.ts";
import { renderPagePreview, type PageActivation } from "./link-reader-page-preview.ts";
import {
  parsePreviewResponse,
  previewContextFor,
  type PreviewContext,
  type CacheEntry,
  renderLoading,
  renderPreview,
  renderPreviewError,
  type LinkPreview,
} from "./link-reader-preview.ts";
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

export class LinkReaderHovercardProvider extends ReactiveElement {
  // Lit must replay values assigned before the lazy custom element upgrades,
  // otherwise own properties shadow the identity-resetting accessors below.
  static override properties = {
    client: { attribute: false, noAccessor: true },
    agentId: { attribute: false, noAccessor: true },
    readers: { attribute: false, noAccessor: true },
    previewSeeds: { attribute: false, noAccessor: true },
    pagePreviewContext: { attribute: false },
    claimedReaders: { attribute: false, noAccessor: true },
  };

  declare pagePreviewContext?: ApplicationContext;
  private page: PageActivation | null = null;
  private allReaders: readonly ControlUiLinkReaderDescriptor[] = EMPTY_LINK_READERS;
  get claimedReaders() {
    return this.allReaders;
  }
  set claimedReaders(value: readonly ControlUiLinkReaderDescriptor[]) {
    if (
      value.length === this.allReaders.length &&
      value.every((reader, index) => reader === this.allReaders[index])
    ) {
      return;
    }
    this.allReaders = value;
    this.retirePage();
  }
  private readonly subscriptions = new SubscriptionsController(this);
  constructor() {
    super();
    this.subscriptions.watch(
      () => this.pagePreviewContext?.gateway,
      (gateway, notify) => gateway.subscribe(notify),
      () => this.retirePage(),
    );
    this.subscriptions.watch(
      () => this.pagePreviewContext?.config,
      (config, notify) => config.subscribe(notify),
      () => {
        if (this.client && !this.pagePreviewContext?.config.current.automaticallyFetchFavicons) {
          clearLinkPreviews(this.client);
        }
        this.retirePage();
      },
    );
  }

  private gatewayClient: GatewayBrowserClient | null = null;
  private selectedAgentId: string | undefined;
  private readerDescriptors: readonly ControlUiLinkReaderDescriptor[] = EMPTY_LINK_READERS;

  get readers(): readonly ControlUiLinkReaderDescriptor[] {
    return this.readerDescriptors;
  }
  set readers(value: readonly ControlUiLinkReaderDescriptor[]) {
    if (
      value.length === this.readerDescriptors.length &&
      value.every((reader, index) => reader === this.readerDescriptors[index])
    ) {
      return;
    }
    this.invalidatePreviewContext();
    this.readerDescriptors = value;
    this.seeds = null;
    this.dispatchEvent(new Event("link-reader-capabilities-changed"));
  }

  private seeds: {
    client: GatewayBrowserClient | null;
    agentId: string | undefined;
    generation: number | undefined;
    recoveryScope: string | undefined;
    previews: readonly ControlUiLinkReaderPreview[];
  } | null = null;

  get previewSeeds(): readonly ControlUiLinkReaderPreview[] {
    return this.seeds?.previews ?? [];
  }

  set previewSeeds(previews: readonly ControlUiLinkReaderPreview[]) {
    this.seeds = {
      client: this.client,
      agentId: this.agentId,
      generation: this.client?.connectionGeneration,
      recoveryScope: this.client?.recoveryScope,
      previews,
    };
    this.requestUpdate();
  }

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

  get client(): GatewayBrowserClient | null {
    return this.gatewayClient;
  }

  set client(value: GatewayBrowserClient | null) {
    if (value === this.gatewayClient) {
      return;
    }
    this.invalidatePreviewContext();
    this.gatewayClient = value;
    this.dispatchEvent(new Event("link-reader-capabilities-changed"));
  }

  get agentId(): string | undefined {
    return this.selectedAgentId;
  }

  set agentId(value: string | undefined) {
    if (value === this.selectedAgentId) {
      return;
    }
    this.invalidatePreviewContext();
    this.selectedAgentId = value;
    this.dispatchEvent(new Event("link-reader-capabilities-changed"));
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
    for (const anchor of this.querySelectorAll<HTMLAnchorElement>("a.markdown-github-item")) {
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
      !this.isConnected ||
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
  private readonly previewTask = new Task(this, {
    autoRun: false,
    args: () => [this.activeTarget] as const,
    // Share metadata, not navigation: each activation owns its full validated URL.
    task: async ([target], { signal }) =>
      target ? { ...(await this.loadPreview(target, signal)), ...target } : initialState,
  });
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

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "contents";
    this.inlineObserver.observe(this, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href"],
    });
    this.addEventListener("pointerover", this.handlePointerOver);
    this.addEventListener("pointerout", this.handlePointerOut);
    this.addEventListener("focusin", this.handleFocusIn);
    this.addEventListener("focusout", this.handleFocusOut);
    this.addEventListener("keydown", this.hovercard.handleTriggerKeyDown);
    this.addEventListener("click", this.handleClick);
    this.stopI18n ??= i18n.subscribe(() => this.requestUpdate());
  }

  override disconnectedCallback(): void {
    this.removeEventListener("pointerover", this.handlePointerOver);
    this.removeEventListener("pointerout", this.handlePointerOut);
    this.removeEventListener("focusin", this.handleFocusIn);
    this.removeEventListener("focusout", this.handleFocusOut);
    this.removeEventListener("keydown", this.hovercard.handleTriggerKeyDown);
    this.removeEventListener("click", this.handleClick);
    this.inlineObserver.disconnect();
    this.stopI18n?.();
    this.stopI18n = null;
    this.close();
    this.clearPreviews();
    super.disconnectedCallback();
  }

  protected override updated(): void {
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
    if (!this.isConnected || !this.ownsAnchor(anchor) || anchor.href !== target.href) {
      this.close();
      return;
    }
    this.previewTask.render({
      pending: () => {
        const seed = this.seedPreview(target);
        if (this.hovercard.held) {
          if (seed) {
            this.show(anchor, seed, true);
          } else if (this.allowLoading && context?.succeeded) {
            this.show(anchor);
          }
        }
      },
      complete: (preview) => {
        if (preview.href === target.href && (this.hovercard.card || this.hovercard.held)) {
          this.show(anchor, preview);
        }
      },
      error: (error) => {
        if (this.hovercard.card || this.hovercard.held) {
          this.show(anchor, this.seedPreview(target), true, linkReaderErrorMessage(error));
        }
      },
    });
  }

  private readonly handlePointerOver = (event: PointerEvent) => {
    if (event.pointerType === "touch") {
      return;
    }
    const anchor = anchorFromNavigationEvent(event);
    const target = anchor ? resolveHoverPreviewTarget(anchor, this) : null;
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
    if (this.previewTask.status === TaskStatus.PENDING && !this.hovercard.held) {
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
    this.activeAnchorObserver.observe(this, {
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
        void this.previewTask.run([target]);
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
      renderPreview(card, preview, seeded, error);
    } else if (error && this.activeTarget) {
      renderPreviewError(card, this.activeTarget, error);
    } else {
      renderLoading(card);
    }
    this.mountPreview(anchor, card, Boolean(existing));
    if (preview && !seeded && this.previewContext) {
      this.previewContext.succeeded = true;
    }
  }

  private mountPreview(anchor: HTMLAnchorElement, card: HTMLDivElement, existing: boolean): void {
    if (existing) {
      this.hovercard.position();
    } else {
      card.addEventListener("pointerleave", this.handleCardPointerLeave);
      card.addEventListener("keydown", this.hovercard.handleCardKeyDown);
      this.hovercard.markTrigger(anchor);
      this.hovercard.mount(anchor, card, "vertical", true, () => render(nothing, card));
    }
  }

  private ownsAnchor(anchor: HTMLAnchorElement): boolean {
    let owner = composedParent(anchor);
    while (owner && !(owner instanceof LinkReaderHovercardProvider)) {
      owner = composedParent(owner);
    }
    return owner === this;
  }

  private currentPage(page: PageActivation): boolean {
    const current = resolveHoverPreviewTarget(page.anchor, this);
    return (
      this.isConnected &&
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
      this.activeAnchorObserver.observe(this, {
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
    while (this.cache.size > CACHE_LIMIT) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.cache.delete(oldestKey);
    }
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
    void this.previewTask.run([null]);
    this.activeAnchor = null;
    this.activeTarget = null;
    this.activeTrigger = null;
  }
}
