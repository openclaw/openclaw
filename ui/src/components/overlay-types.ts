export type OverlayPhase = "opening" | "open" | "closing" | "hidden";
export type OverlayFocusIntent = "first" | "last" | "return" | "none";

export interface OverlayNativeAdapter {
  isOpen(surface: HTMLElement): boolean;
  show(surface: HTMLElement, source?: HTMLElement): void;
  hide(surface: HTMLElement): void;
}

export interface OverlayOptions {
  native?: OverlayNativeAdapter;
  /** Tooltips describe their invoker without exposing expandable-control semantics. */
  reflectTriggerExpanded?: boolean;
  /** Only members of the same group displace one another. Dialogs have no group. */
  exclusiveGroup?: string;
  isValid?(surface: HTMLElement, trigger?: HTMLElement): boolean;
  dismissOutsidePointer?: boolean;
  dismissOutsideFocus?: boolean;
  dismissEscape?: boolean;
  interactionElements?(): Iterable<Element>;
  onRootChange?(root: Document | ShadowRoot): void | (() => void);
  /** Root-correct input facts; the surface's policy decides whether to dismiss. */
  onInteraction?(this: void, event: PointerEvent | FocusEvent, target: Node | null): void;
  /** Return true when an embedded control consumed Escape without dismissing. */
  onEscape?(event: KeyboardEvent): boolean;
  onInitialFocus?(intent: "first" | "last"): void;
  onReturnFocus?(target: HTMLElement): void;
  beforeNativeHide?(): void;
  acquireOcclusion?(surface: HTMLElement): () => void;
}

export interface Overlay {
  readonly id: string;
  readonly parent?: Overlay;
  readonly children: Set<Overlay>;
  readonly surface: HTMLElement;
  readonly trigger: HTMLElement | undefined;
  /** Accepted state is synchronous; phase tracks the remaining presentation work. */
  readonly open: boolean;
  readonly phase: OverlayPhase;
  readonly revision: number;
  contains(target: Node | null): boolean;
  containsFocus(): boolean;
  retire(): void;
  /** Bind after mounting so subscriptions use the live document, not a template document. */
  bindSurface(node: HTMLElement): void;
  bindTrigger(node: HTMLElement | undefined): void;
  setParent(parent?: Overlay): void;
  setReturnTarget(node: HTMLElement): void;
  subscribe(listener: (open: boolean) => void): () => void;
  request(next: boolean, focus?: OverlayFocusIntent): boolean;
  prepareClose(): (() => boolean) | null;
  nativeToggle(): void;
  keydown(event: KeyboardEvent): void;
  dispose(): void;
}
