import { containsComposed } from "./overlay-registry.ts";
import { isTooltipTextRedundant, normalizeTooltipText } from "./tooltip-content.ts";
import type { TooltipProvider } from "./tooltip.ts";

const DESCRIBABLE_SELECTOR =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
const HOVER_DELAY = 150;
const RICH_CONTENT_CLOSE_DELAY = 100;
let nextTooltipId = 0;
const createTooltipId = () => `openclaw-tooltip-${++nextTooltipId}`;

export type TooltipPlacement =
  | "top"
  | "top-start"
  | "top-end"
  | "bottom"
  | "bottom-start"
  | "bottom-end"
  | "left"
  | "left-start"
  | "left-end"
  | "right"
  | "right-start"
  | "right-end";
export interface TooltipPolicyProps {
  content?: string;
  placement?: TooltipPlacement;
  closeDelay?: number;
  hoverDismissDelay?: number;
  delay?: number;
  describe?: boolean;
  autoSize?: boolean;
  disabled?: boolean;
  openOnClick?: boolean;
  anchor?: HTMLElement | SVGElement | null;
}
export interface TooltipPolicyOptions {
  props: () => TooltipPolicyProps;
  trigger: () => HTMLElement | SVGElement | null;
  richContent: () => readonly Node[];
  richContainer: () => HTMLElement | null;
  requestOpen: (open: boolean) => boolean;
  retire: () => void;
  preview: (anchor: HTMLElement | SVGElement, content: string) => void;
}

export class TooltipController {
  static readonly #activeByDocument = new WeakMap<Document, TooltipController>();
  static readonly #pendingByDocument = new WeakMap<Document, TooltipController>();

  static readonly consumeEscape = (event: KeyboardEvent, ownerDocument: Document): boolean => {
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      event.isComposing ||
      event.keyCode === 229
    ) {
      return false;
    }
    const active =
      TooltipController.#pendingByDocument.get(ownerDocument) ??
      TooltipController.#activeByDocument.get(ownerDocument);
    if (!active) {
      return false;
    }
    // Block native dialog cancellation and later listeners on this capture target.
    event.preventDefault();
    event.stopImmediatePropagation();
    const focused = active.#focusedInteractionElement();
    const restoreTarget =
      focused &&
      containsComposed(active.host, focused) &&
      !containsComposed(active.#triggerElement ?? undefined, focused)
        ? active.#resolveDescribedElement()
        : null;
    const accepted = active.#close();
    if (accepted && restoreTarget instanceof HTMLElement) {
      active.focusTriggerWithoutOpening(restoreTarget);
    }
    return true;
  };

  static closeForProvider(provider: TooltipProvider) {
    const active =
      TooltipController.#pendingByDocument.get(provider.ownerDocument) ??
      TooltipController.#activeByDocument.get(provider.ownerDocument);
    if (active && active.#tooltipProvider === provider) {
      active.options.retire();
    }
  }

  #triggerElement: HTMLElement | SVGElement | null = null;
  #pinned = false;
  #pending = false;
  #describedElement: Element | null = null;
  #openTimer: number | null = null;
  #closeTimer: number | null = null;
  #triggerHovered = false;
  #contentHovered = false;
  #hoverExitPending = false;
  #describedBy: string | null = null;
  #descriptionCaptured = false;
  #suppressNextFocusOpen = false;
  #focusRevision = 0;
  #descriptionElement: HTMLSpanElement | null = null;
  #richContentObserver: MutationObserver | null = null;
  readonly #triggerContentObserver = new MutationObserver(() => this.#syncDescription());
  #tooltipProvider: TooltipProvider | null = null;
  #presentationAncestors: Node[] = [];
  readonly #presentationObserver = new MutationObserver(() => {
    if (!this.#isPresented()) {
      this.options.retire();
    } else {
      this.#observePresentation();
    }
  });
  readonly #tooltipId = createTooltipId();
  readonly #descriptionId = `${this.#tooltipId}-description`;

  constructor(
    readonly host: HTMLElement,
    private readonly options: TooltipPolicyOptions,
  ) {}
  get content() {
    return this.options.props().content ?? "";
  }
  get placement() {
    return this.options.props().placement ?? "top";
  }
  get closeDelay() {
    return this.options.props().closeDelay ?? RICH_CONTENT_CLOSE_DELAY;
  }
  get hoverDismissDelay() {
    return this.options.props().hoverDismissDelay;
  }
  get delay() {
    return this.options.props().delay;
  }
  get describe() {
    return this.options.props().describe ?? true;
  }
  get disabled() {
    return this.options.props().disabled ?? false;
  }
  get openOnClick() {
    return this.options.props().openOnClick ?? false;
  }
  get anchor() {
    return this.options.props().anchor;
  }
  get id() {
    return this.#tooltipId;
  }
  get trigger() {
    return this.#triggerElement;
  }
  get resolvedPlacement(): TooltipPlacement {
    return (this.placement === "right-start" || this.placement === "right") &&
      this.host.ownerDocument.defaultView?.matchMedia?.("(max-width: 640px)").matches
      ? "bottom-start"
      : this.placement;
  }
  refresh() {
    this.#attachTrigger();
    this.contentChanged();
    if (this.disabled || !this.#tooltipText) {
      this.options.retire();
    } else if (this.host.hasAttribute("open") && this.#isRedundant()) {
      this.#close();
    }
  }
  dispose() {
    this.acceptedOpen(false);
    this.#richContentObserver?.disconnect();
    this.#richContentObserver = null;
    this.#tooltipProvider = null;
    this.#detachTrigger();
  }
  close() {
    this.#close();
  }
  #attachTrigger() {
    const trigger = this.anchor ?? this.options.trigger();
    if (trigger === this.#triggerElement) {
      return;
    }
    this.options.retire();
    this.#detachTrigger();
    if (!trigger) {
      return;
    }
    this.#triggerElement = trigger;
    this.#tooltipProvider = null;
    let owner: Element | null = trigger;
    while (owner) {
      const provider = owner.closest<TooltipProvider>("openclaw-tooltip-provider");
      if (provider) {
        this.#tooltipProvider = provider;
        break;
      }
      const root = owner.getRootNode();
      owner = root instanceof ShadowRoot ? root.host : null;
    }
    this.#triggerContentObserver.observe(trigger, { childList: true, subtree: true });
    trigger.addEventListener("pointerenter", this.#handlePointerEnter);
    trigger.addEventListener("pointerleave", this.#handlePointerLeave);
    trigger.addEventListener("pointerdown", this.#handlePointerDown);
    trigger.addEventListener("pointercancel", this.#handlePointerCancel);
    trigger.addEventListener("focusin", this.handleFocusIn);
    trigger.addEventListener("focusout", this.handleFocusOut);
    trigger.addEventListener("click", this.#handleClick, true);
    this.#observeRichContent();
    this.#syncDescription();
  }

  #detachTrigger() {
    const trigger = this.#triggerElement;
    if (!trigger) {
      return;
    }
    this.#triggerContentObserver.disconnect();
    trigger.removeEventListener("pointerenter", this.#handlePointerEnter);
    trigger.removeEventListener("pointerleave", this.#handlePointerLeave);
    trigger.removeEventListener("pointerdown", this.#handlePointerDown);
    trigger.removeEventListener("pointercancel", this.#handlePointerCancel);
    trigger.removeEventListener("focusin", this.handleFocusIn);
    trigger.removeEventListener("focusout", this.handleFocusOut);
    trigger.removeEventListener("click", this.#handleClick, true);
    this.#restoreDescription();
    this.#triggerElement = null;
  }

  previewForAnchor(anchor: HTMLElement | SVGElement, content: string, input: "pointer" | "focus") {
    this.options.preview(anchor, content);
    if (this.anchor !== anchor || !anchor.isConnected || !this.host.isConnected) {
      return;
    }
    this.refresh();
    if (input === "focus") {
      this.handleFocusIn();
    } else {
      this.#triggerHovered = true;
      this.#scheduleOpen();
    }
  }

  readonly #handlePointerEnter = (event: Event) => {
    if (!("pointerType" in event) || event.pointerType !== "touch") {
      this.#triggerHovered = true;
      this.#hoverExitPending = false;
      this.#clearCloseTimer();
      this.#scheduleOpen();
    }
  };

  readonly #handlePointerLeave = (event: Event) => {
    if (!("pointerType" in event) || event.pointerType !== "touch") {
      this.#triggerHovered = false;
      this.#hoverExitPending = true;
      this.#clearTimers(false);
      this.#maybeClose();
    }
  };

  readonly handleContentPointerEnter = (event: PointerEvent) => {
    if (event.pointerType !== "touch") {
      this.#contentHovered = true;
      this.#hoverExitPending = false;
      this.#clearCloseTimer();
      this.#show();
    }
  };

  readonly handleContentPointerLeave = (event: PointerEvent) => {
    if (event.pointerType !== "touch") {
      this.#contentHovered = false;
      this.#hoverExitPending = true;
      this.#maybeClose();
    }
  };

  readonly #handlePointerDown = () => {
    if (!this.openOnClick) {
      this.#close();
    }
  };

  readonly #handlePointerCancel = () => {
    this.#close();
  };
  readonly handleFocusIn = () => {
    this.#focusRevision += 1;
    if (this.#suppressNextFocusOpen) {
      this.#suppressNextFocusOpen = false;
      this.#close();
      return;
    }
    if (this.#tooltipProvider?.focusOpensTooltip() !== false) {
      this.#show();
    }
  };
  readonly handleFocusOut = (event: Event) => {
    if (
      (event instanceof FocusEvent &&
        event.relatedTarget instanceof Node &&
        this.#containsInteractionTarget(event.relatedTarget)) ||
      this.#pinned ||
      this.#triggerHovered ||
      this.#contentHovered
    ) {
      return;
    }
    if (event instanceof FocusEvent && event.relatedTarget === null) {
      const revision = this.#focusRevision;
      const trigger = this.#triggerElement;
      // Chromium blurs a removed trigger before disconnecting its subtree.
      // Let that removal retire silently, while preserving ordinary blur dismissal.
      queueMicrotask(() => {
        if (
          revision !== this.#focusRevision ||
          trigger !== this.#triggerElement ||
          this.#shouldRemainOpen()
        ) {
          return;
        }
        if (!this.host.isConnected || !trigger?.isConnected) {
          this.options.retire();
        } else {
          this.#close();
        }
      });
      return;
    }
    this.#close();
  };
  // Pointer activation normally dismisses, so an action button never strands an
  // open tooltip. A trigger whose only job is to reveal the tip opts out: on
  // touch and in browsers that do not focus buttons on click there is no other
  // way to read it.
  readonly #handleClick = () => {
    if (this.openOnClick && !this.#pinned) {
      this.#pinned = this.#show();
      return;
    }
    this.#close();
  };

  #scheduleOpen() {
    if (
      this.disabled ||
      this.#pending ||
      this.host.hasAttribute("open") ||
      this.#openTimer !== null
    ) {
      return;
    }
    const provider = this.#tooltipProvider;
    const delay =
      this.delay === undefined && provider?.delayed === false
        ? 0
        : Math.max(0, this.delay ?? HOVER_DELAY);
    this.#openTimer = window.setTimeout(() => {
      this.#openTimer = null;
      this.#show();
    }, delay);
  }

  #show() {
    if (
      this.disabled ||
      !this.#triggerElement ||
      !this.#tooltipText ||
      this.#isRedundant() ||
      !this.#isPresented()
    ) {
      return false;
    }
    return this.options.requestOpen(true);
  }

  /** Loading is cancelable intent; only the overlay lifecycle may accept visibility. */
  pendingOpen() {
    const previous = TooltipController.#pendingByDocument.get(this.host.ownerDocument);
    if (previous && previous !== this) {
      previous.#close();
    }
    this.#pending = true;
    this.#observePresentation();
    TooltipController.#pendingByDocument.set(this.host.ownerDocument, this);
    this.host.ownerDocument.defaultView?.addEventListener(
      "keydown",
      this.#handleWindowKeyDown,
      true,
    );
  }

  /** Apply only lifecycle-admitted state; canceled requests never alter interaction policy. */
  acceptedOpen(open: boolean) {
    this.#pending = false;
    if (TooltipController.#pendingByDocument.get(this.host.ownerDocument) === this) {
      TooltipController.#pendingByDocument.delete(this.host.ownerDocument);
    }
    if (!open) {
      this.#presentationObserver.disconnect();
      this.#presentationAncestors = [];
      this.#pinned = false;
      this.host.removeAttribute("open");
      this.options.richContainer()?.setAttribute("inert", "");
      this.host.ownerDocument.defaultView?.removeEventListener(
        "keydown",
        this.#handleWindowKeyDown,
        true,
      );
      this.#clearTimers();
      if (TooltipController.#activeByDocument.get(this.host.ownerDocument) === this) {
        TooltipController.#activeByDocument.delete(this.host.ownerDocument);
        this.#tooltipProvider?.closeTooltip();
      }
      return;
    }
    this.#clearTimers(false);
    this.#observePresentation();
    TooltipController.#activeByDocument.set(this.host.ownerDocument, this);
    this.#tooltipProvider?.openTooltip();
    this.#syncDescription();
    this.host.setAttribute("open", "");
    this.options.richContainer()?.removeAttribute("inert");
    this.host.ownerDocument.defaultView?.addEventListener(
      "keydown",
      this.#handleWindowKeyDown,
      true,
    );
  }

  // Capture before dialogs/default actions; earlier capture owners use the same consumer.
  readonly #handleWindowKeyDown = (event: KeyboardEvent) => {
    TooltipController.consumeEscape(event, this.host.ownerDocument);
  };

  handleInteraction(event: PointerEvent | FocusEvent, target: Node | null) {
    if (event.type === "pointermove") {
      if (
        "pointerType" in event &&
        event.pointerType !== "touch" &&
        this.hoverDismissDelay !== undefined &&
        this.#hoverExitPending &&
        this.#closeTimer === null &&
        !this.#containsInteractionTarget(target)
      ) {
        // A shrinking preview can leave a stationary pointer after deletion.
        // Only an actual pointer move dismisses an action that retained focus.
        this.#maybeClose(true);
      }
      return;
    }
    if (!this.#containsInteractionTarget(target)) {
      this.#close();
    }
  }

  #containsInteractionTarget(target: Node | null) {
    return (
      containsComposed(this.host, target) ||
      containsComposed(this.#triggerElement ?? undefined, target)
    );
  }

  #close() {
    return this.options.requestOpen(false);
  }

  #triggerAncestors() {
    const ancestors: Node[] = [];
    let node: Node | null = this.#triggerElement;
    while (node) {
      ancestors.push(node);
      node =
        node instanceof Element && node.assignedSlot
          ? node.assignedSlot
          : node instanceof ShadowRoot
            ? node.host
            : node.parentNode;
    }
    return ancestors;
  }

  #isPresented() {
    return (
      this.#triggerElement?.isConnected === true &&
      !this.#triggerAncestors().some(
        (node) =>
          node instanceof Element &&
          (node.hasAttribute("hidden") ||
            node.hasAttribute("inert") ||
            node.getAttribute("aria-hidden") === "true"),
      )
    );
  }

  #observePresentation() {
    const ancestors = this.#triggerAncestors();
    if (
      ancestors.length === this.#presentationAncestors.length &&
      ancestors.every((node, index) => node === this.#presentationAncestors[index])
    ) {
      return;
    }
    this.#presentationObserver.disconnect();
    this.#presentationAncestors = ancestors;
    for (const node of ancestors) {
      this.#presentationObserver.observe(node, {
        childList: true,
        attributes: true,
        attributeFilter: ["hidden", "inert", "aria-hidden"],
      });
    }
  }

  #isRedundant() {
    return (
      !this.#richContentText &&
      this.#triggerElement !== null &&
      isTooltipTextRedundant(this.content, this.#triggerElement)
    );
  }

  #resolveDescribedElement(): Element | null {
    const trigger = this.#triggerElement;
    if (!trigger) {
      return null;
    }
    return trigger.matches(DESCRIBABLE_SELECTOR)
      ? trigger
      : (trigger.querySelector(DESCRIBABLE_SELECTOR) ?? trigger);
  }

  #syncDescription() {
    const richText = this.#richContentText;
    this.options
      .richContainer()
      ?.closest<HTMLElement>(".tooltip-surface")
      ?.style.setProperty("pointer-events", richText ? "auto" : "none");
    if (!this.describe) {
      this.#restoreDescription();
      return;
    }
    const trigger = this.#resolveDescribedElement();
    if (!trigger) {
      return;
    }
    if (trigger !== this.#describedElement) {
      this.#restoreDescription();
      this.#describedElement = trigger;
    }
    const current = trigger.getAttribute("aria-describedby");
    if (!this.#descriptionCaptured) {
      this.#describedBy = current;
      this.#descriptionCaptured = true;
    }
    if (!this.#descriptionElement) {
      // ownerDocument, not the global: slotchange can fire after a test
      // environment tears down its window, where bare `document` throws.
      const description = this.host.ownerDocument.createElement("span");
      description.id = this.#descriptionId;
      description.hidden = true;
      this.#descriptionElement = description;
    }
    const root = trigger.getRootNode();
    const view = trigger.ownerDocument.defaultView;
    const descriptionRoot =
      view && root instanceof view.ShadowRoot ? root : trigger.ownerDocument.body;
    if (
      this.#descriptionElement.getRootNode() !== root &&
      this.#descriptionElement.parentNode !== descriptionRoot
    ) {
      descriptionRoot.append(this.#descriptionElement);
    }
    const descriptionText = richText || this.content;
    if (this.#descriptionElement.textContent !== descriptionText) {
      this.#descriptionElement.textContent = descriptionText;
    }
    const ids = new Set((current ?? "").split(/\s+/u).filter(Boolean));
    ids.add(this.#descriptionId);
    const descriptionIds = [...ids].join(" ");
    if (current !== descriptionIds) {
      trigger.setAttribute("aria-describedby", descriptionIds);
    }
  }

  #restoreDescription() {
    const described = this.#describedElement;
    if (!this.#descriptionCaptured || !described) {
      return;
    }
    if (this.#describedBy !== null) {
      described.setAttribute("aria-describedby", this.#describedBy);
    } else {
      described.removeAttribute("aria-describedby");
    }
    this.#describedElement = null;
    this.#descriptionElement?.remove();
    this.#descriptionElement = null;
    this.#describedBy = null;
    this.#descriptionCaptured = false;
  }

  #clearCloseTimer() {
    if (this.#closeTimer !== null) {
      window.clearTimeout(this.#closeTimer);
      this.#closeTimer = null;
    }
  }

  #focusedInteractionElement(): Element | null {
    const document = this.host.ownerDocument;
    const view = document.defaultView;
    const roots = new Set([
      this.options.richContainer()?.getRootNode(),
      this.#triggerElement?.getRootNode(),
      this.host.getRootNode(),
      document,
    ]);
    for (const root of roots) {
      const focused =
        view && root instanceof view.ShadowRoot ? root.activeElement : document.activeElement;
      if (focused && this.#containsInteractionTarget(focused)) {
        return focused;
      }
    }
    return null;
  }

  #shouldRemainOpen(pointerExit = false) {
    if (pointerExit) {
      return this.#triggerHovered || this.#contentHovered;
    }
    return (
      this.#pinned ||
      this.#triggerHovered ||
      this.#contentHovered ||
      this.#focusedInteractionElement() !== null
    );
  }

  #maybeClose(pointerExit = false) {
    this.#clearCloseTimer();
    if (this.#shouldRemainOpen(pointerExit)) {
      return;
    }
    if (!this.#richContentText) {
      this.#close();
      return;
    }
    this.#closeTimer = window.setTimeout(() => {
      this.#closeTimer = null;
      if (!this.#shouldRemainOpen(pointerExit)) {
        this.#close();
      }
    }, this.hoverDismissDelay ?? this.closeDelay);
  }

  #clearTimers(resetHover = true) {
    if (this.#openTimer !== null) {
      window.clearTimeout(this.#openTimer);
      this.#openTimer = null;
    }
    this.#clearCloseTimer();
    if (resetHover) {
      this.#triggerHovered = false;
      this.#contentHovered = false;
      this.#hoverExitPending = false;
    }
  }

  get #richContentText() {
    const nodes = this.options.richContent();
    return normalizeTooltipText(nodes.map((node) => node.textContent ?? "").join(" ") ?? "");
  }

  get #tooltipText() {
    return this.#richContentText || this.content;
  }

  #observeRichContent() {
    this.#richContentObserver?.disconnect();
    this.#richContentObserver ??= new MutationObserver(() => this.#syncDescription());
    const nodes = this.options.richContent();
    for (const node of nodes) {
      this.#richContentObserver.observe(node, {
        characterData: true,
        childList: true,
        subtree: true,
      });
    }
  }

  readonly contentChanged = () => {
    this.#observeRichContent();
    this.#syncDescription();
    if (!this.#tooltipText) {
      this.options.retire();
    }
  };

  focusTriggerWithoutOpening(target: HTMLElement) {
    if (this.#triggerElement?.contains(target) && !target.matches(":focus")) {
      // Navigation can replace a focused toggle with its inverse. Preserve the
      // focus handoff without presenting it as fresh tooltip intent.
      this.#suppressNextFocusOpen = true;
    }
    target.focus();
  }
}

export const consumeTooltipEscape = TooltipController.consumeEscape;
