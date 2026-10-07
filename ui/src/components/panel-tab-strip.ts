import { css, html, nothing, type TemplateResult } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "./icons.ts";
import "./tooltip.ts";
import "./web-awesome-tabs.ts";

export type PanelTabStripTab = {
  id: string;
  domId: string;
  label: string;
  labelTooltip?: string | null;
  title?: string | null;
  icon?: TemplateResult | typeof nothing | null;
  statusLabel?: string | null;
  /** Short ownership marker (e.g. "agent") rendered as a pill after the label. */
  badge?: string | null;
  className?: string;
  closeLabel: string;
  group?: string;
  draggable?: boolean;
  reorderId?: string;
  /** Explicit click/Enter/Space action; arrow-key selection still uses onSelect. */
  onActivate?: () => void;
};

const reconciledTabLayouts = new WeakMap<Element, string>();
const keyboardCloseActivations = new WeakSet<Element>();
const PANEL_TAB_DRAG_TYPE = "application/x-openclaw-panel-tab";

function clearPanelTabDropTargets(element: Element): void {
  const group = element.closest<HTMLElement>("wa-tab-group");
  group
    ?.querySelectorAll(".is-drop-before, .is-drop-after")
    .forEach((target) => target.classList.remove("is-drop-before", "is-drop-after"));
}

function draggedPanelTabId(element: Element): string {
  return element.closest<HTMLElement>("wa-tab-group")?.dataset.draggedPanelTab ?? "";
}

function finishPanelTabDrag(element: Element): void {
  clearPanelTabDropTargets(element);
  element.closest<HTMLElement>("wa-tab-group")?.removeAttribute("data-dragged-panel-tab");
}

function activeElementFor(element: Element): Element | null {
  const root = element.getRootNode();
  return root instanceof ShadowRoot
    ? (root.activeElement ?? document.activeElement)
    : document.activeElement;
}

function deepestActiveElementId(): string | null {
  let active = document.activeElement;
  while (active instanceof HTMLElement && active.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active instanceof HTMLElement ? active.id : null;
}

function focusNeedsRecovery(element: Element, current: Element | null): boolean {
  const root = element.getRootNode();
  return (
    current === document.body ||
    current === document.documentElement ||
    (root instanceof ShadowRoot && current === root.host)
  );
}

class PanelTabMeasurementsDirective extends AsyncDirective {
  #element: Element | undefined;
  #scroller: HTMLElement | undefined;
  #resizeObserver: ResizeObserver | undefined;
  #mutationObserver: MutationObserver | undefined;
  #observed = new Set<Element>();
  #frame: number | undefined;
  #generation = 0;
  #layoutKey: string | undefined;
  #direction: string | undefined;

  render(_layoutKey: string) {
    return nothing;
  }

  override update(part: ElementPart, [layoutKey]: [string]) {
    if (!this.#element) {
      this.#element = part.element;
      this.#connect();
    }
    const direction = this.#element.ownerDocument.documentElement.dir;
    if (this.#layoutKey !== layoutKey || this.#direction !== direction) {
      this.#layoutKey = layoutKey;
      this.#direction = direction;
      this.#schedule();
    }
    return nothing;
  }

  #connect() {
    const element = this.#element;
    if (!element || !this.isConnected) {
      return;
    }
    const generation = ++this.#generation;
    // Text can change its overflow without changing the label's observed width.
    this.#mutationObserver = new MutationObserver(this.#schedule);
    this.#mutationObserver.observe(element, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    void (async () => {
      await (element as Element & { updateComplete?: Promise<unknown> }).updateComplete;
      if (generation !== this.#generation || !this.isConnected || !element.isConnected) {
        return;
      }
      this.#scroller =
        element.shadowRoot?.querySelector<HTMLElement>('[part~="tabs"]') ?? undefined;
      this.#scroller?.addEventListener("scroll", this.#schedule, { passive: true });
      if (typeof ResizeObserver === "function") {
        this.#resizeObserver = new ResizeObserver(this.#schedule);
        if (this.#scroller) {
          this.#resizeObserver.observe(this.#scroller);
          this.#observed.add(this.#scroller);
        }
      }
      this.#schedule();
    })();
  }

  readonly #schedule = () => {
    if (this.#frame !== undefined || !this.isConnected || !this.#scroller) {
      return;
    }
    this.#frame = requestAnimationFrame(() => {
      this.#frame = undefined;
      const element = this.#element;
      const scroller = this.#scroller;
      if (!this.isConnected || !element?.isConnected || !scroller) {
        return;
      }
      const children = [...element.children];
      const labels = [...element.querySelectorAll<HTMLElement>(".tabstrip-tab__label")];
      const observed = new Set<Element>([scroller, ...children, ...labels]);
      for (const target of this.#observed) {
        if (!observed.has(target)) {
          this.#resizeObserver?.unobserve(target);
        }
      }
      for (const target of observed) {
        if (!this.#observed.has(target)) {
          this.#resizeObserver?.observe(target);
        }
      }
      this.#observed = observed;

      // Read the completed row together before any overflow classes can dirty layout.
      const overflow = labels.map((label) => ({
        label,
        overflowing: label.scrollWidth > label.clientWidth + 1,
      }));
      const rects = children.map((child) => child.getBoundingClientRect());
      const viewport = scroller.getBoundingClientRect();
      // Rects are physical in both writing directions; scrollLeft is not.
      // Keep resting tabs clear of the fade despite inline padding and rounding.
      const left = rects.some((rect) => viewport.left - rect.left > 8);
      const right = rects.some((rect) => rect.right - viewport.right > 8);
      overflow.forEach(({ label, overflowing }) => {
        label.classList.toggle("is-overflowing", overflowing);
        label.parentElement?.classList.toggle("has-label-overflow", overflowing);
        label.toggleAttribute("data-tooltip-overflow", overflowing);
      });
      element.classList.toggle("has-scroll-left", left);
      element.classList.toggle("has-scroll-right", right);
    });
  };

  protected override disconnected() {
    this.#generation += 1;
    this.#mutationObserver?.disconnect();
    this.#resizeObserver?.disconnect();
    this.#observed.clear();
    this.#scroller?.removeEventListener("scroll", this.#schedule);
    this.#scroller = undefined;
    if (this.#frame !== undefined) {
      cancelAnimationFrame(this.#frame);
      this.#frame = undefined;
    }
  }

  protected override reconnected() {
    this.#connect();
  }
}

const panelTabMeasurements = directive(PanelTabMeasurementsDirective);

/** "before"/"after" are array order, but pointer position is physical: under RTL
 *  the visually leading half of a tab is its right half. Both drag handlers read
 *  this, or the indicator previews the opposite edge from the actual drop. */
function panelTabDropPlacement(event: DragEvent, target: Element): "before" | "after" {
  const bounds = target.getBoundingClientRect();
  const pastMidpoint = event.clientX > bounds.left + bounds.width / 2;
  const isRtl = getComputedStyle(target).direction === "rtl";
  return pastMidpoint === isRtl ? "before" : "after";
}

function reconcileSelectedTabElement(
  element: Element | undefined,
  layoutKey: string,
  restoreFocus: boolean,
): void {
  if (!(element instanceof HTMLElement)) {
    return;
  }
  const layoutChanged = reconciledTabLayouts.get(element) !== layoutKey;
  reconciledTabLayouts.set(element, layoutKey);
  if (!layoutChanged && !restoreFocus) {
    return;
  }
  // Keyed movement or a new selection can leave the active tab clipped by the
  // overflow viewport, which reads as an icon-only tab. Reconcile those changes.
  queueMicrotask(() => {
    if (!element.isConnected) {
      return;
    }
    const currentGroup = element.closest("wa-tab-group");
    const updateComplete =
      (currentGroup as (HTMLElement & { updateComplete?: Promise<unknown> }) | null)
        ?.updateComplete ?? Promise.resolve();
    void updateComplete.then(() => {
      if (!element.isConnected) {
        return;
      }
      element.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      const current = activeElementFor(element);
      if (restoreFocus && focusNeedsRecovery(element, current)) {
        element.focus({ preventScroll: true });
      }
    });
  });
}

export function renderPanelTabStrip<T extends PanelTabStripTab>(params: {
  tabs: T[];
  activeId: string | null;
  ariaControls: string | ((tab: T) => string);
  onSelect: (id: string) => void;
  onClose: (id: string) => void | Promise<void>;
  onNew: () => void;
  newLabel: string;
  newDisabled?: boolean;
  newTabAction?: boolean;
  newControl?: TemplateResult | typeof nothing;
  separateTabs?: boolean;
  onReorder?: (sourceId: string, targetId: string, placement: "before" | "after") => void;
}) {
  const controlsFor = (tab: T) =>
    typeof params.ariaControls === "string" ? params.ariaControls : params.ariaControls(tab);
  const newControlId = params.tabs[0] ? `${params.tabs[0].domId}-new` : undefined;
  const newButton = (slotted: boolean) =>
    params.newControl === nothing
      ? nothing
      : params.newControl
        ? html`<span
            id=${newControlId ?? nothing}
            slot=${slotted ? "nav" : nothing}
            class="tabstrip-new-control"
            >${params.newControl}</span
          >`
        : html`
            <button
              id=${newControlId ?? nothing}
              slot=${slotted ? "nav" : nothing}
              class="rail-header__action tabstrip-new"
              type="button"
              ?data-new-tab-action=${params.newTabAction}
              ?disabled=${params.newDisabled}
              title=${params.newLabel}
              aria-label=${params.newLabel}
              @click=${params.onNew}
            >
              ${icons.plus}
            </button>
          `;
  if (params.tabs.length === 0) {
    // Web Awesome 3.10 dereferences its first tab when an empty group becomes
    // visible. Keep the new-session control outside the group until one exists.
    return newButton(false);
  }
  // Event callbacks retain this render scope; keep focus identity without retaining its DOM tree.
  const activeElementId = deepestActiveElementId();
  const focusedTabDomId = params.tabs.some((tab) => tab.domId === activeElementId)
    ? activeElementId
    : null;
  // Selection belongs in the key: activating a clipped tab has to scroll it back
  // into view, otherwise it stays cut off at the viewport edge as icon-only.
  // Serialized rather than joined: a delimiter can appear inside an id, and two
  // different layouts must never produce the same key.
  const layoutKey = JSON.stringify([params.activeId, params.tabs.map((tab) => tab.id)]);
  // A new class binding replaces overflow markers even when dimensions stay equal.
  const measurementKey = JSON.stringify([layoutKey, params.tabs.map((tab) => tab.className)]);
  return html`
    <wa-tab-group
      class="tabstrip"
      ${panelTabMeasurements(measurementKey)}
      .active=${params.activeId ?? ""}
      activation="auto"
      without-scroll-controls
      @wa-tab-show=${(event: CustomEvent<{ name: string }>) => {
        // Web Awesome also emits for controlled selection updates. Echoing those
        // as user actions can reopen a panel that its owner just focused away.
        if (event.detail.name !== params.activeId) {
          params.onSelect(event.detail.name);
        }
      }}
    >
      ${repeat(
        params.tabs,
        (tab) => tab.id,
        (tab, index) => {
          const selected = tab.id === params.activeId;
          const reorderId = tab.reorderId ?? tab.id;
          const draggable = Boolean(params.onReorder) && tab.draggable !== false;
          // Every gap outside a group keeps its separator so activating a tab cannot
          // reflow the row; the pair touching the active tab is faded out in CSS instead.
          const showSeparator =
            params.separateTabs === true &&
            index < params.tabs.length - 1 &&
            (tab.group === undefined || tab.group !== params.tabs[index + 1]?.group);
          const tabContent = html`
            ${
              tab.icon == null || tab.icon === nothing
                ? nothing
                : html`<span class="tabstrip-tab__icon" aria-hidden="true">${tab.icon}</span>`
            }
            <span class="tabstrip-tab__label">${tab.label}</span>
            ${tab.badge ? html`<span class="tabstrip-tab__badge">${tab.badge}</span>` : nothing}
            ${
              tab.statusLabel
                ? html`<span class="tabstrip-tab__status">${tab.statusLabel}</span>`
                : nothing
            }
          `;
          return html`
            <wa-tab
              id=${tab.domId}
              class=${`tabstrip-tab ${tab.className ?? ""}`}
              panel=${tab.id}
              aria-controls=${controlsFor(tab)}
              aria-selected=${selected ? "true" : "false"}
              title=${tab.title || nothing}
              ?active=${selected}
              draggable=${draggable ? "true" : nothing}
              .tabIndex=${selected ? 0 : -1}
              ${
                selected
                  ? ref((element) =>
                      reconcileSelectedTabElement(
                        element,
                        layoutKey,
                        focusedTabDomId === tab.domId,
                      ),
                    )
                  : nothing
              }
              @click=${(event: MouseEvent) => {
                if (tab.onActivate) {
                  event.stopPropagation();
                  tab.onActivate();
                }
              }}
              @keydown=${(event: KeyboardEvent) => {
                if (tab.onActivate && (event.key === "Enter" || event.key === " ")) {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!event.repeat) {
                    tab.onActivate();
                  }
                }
              }}
              @auxclick=${(event: MouseEvent) => {
                if (event.button === 1) {
                  event.preventDefault();
                  void params.onClose(tab.id);
                }
              }}
              @dragstart=${(event: DragEvent) => {
                if (!draggable || !event.dataTransfer) {
                  return;
                }
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(PANEL_TAB_DRAG_TYPE, reorderId);
                if (event.currentTarget instanceof Element) {
                  const group = event.currentTarget.closest<HTMLElement>("wa-tab-group");
                  if (group) {
                    group.dataset.draggedPanelTab = reorderId;
                  }
                }
              }}
              @dragover=${(event: DragEvent) => {
                if (!params.onReorder || !event.dataTransfer) {
                  return;
                }
                const sourceId =
                  event.currentTarget instanceof Element
                    ? draggedPanelTabId(event.currentTarget)
                    : "";
                if (!sourceId || sourceId === reorderId) {
                  return;
                }
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                const target = event.currentTarget;
                if (!(target instanceof Element)) {
                  return;
                }
                clearPanelTabDropTargets(target);
                target.classList.add(`is-drop-${panelTabDropPlacement(event, target)}`);
              }}
              @dragleave=${(event: DragEvent) => {
                if (
                  event.currentTarget instanceof Element &&
                  !(
                    event.relatedTarget instanceof Node &&
                    event.currentTarget.contains(event.relatedTarget)
                  )
                ) {
                  event.currentTarget.classList.remove("is-drop-before", "is-drop-after");
                }
              }}
              @drop=${(event: DragEvent) => {
                if (!params.onReorder || !event.dataTransfer) {
                  return;
                }
                const target = event.currentTarget;
                const sourceId =
                  target instanceof Element
                    ? draggedPanelTabId(target) || event.dataTransfer.getData(PANEL_TAB_DRAG_TYPE)
                    : "";
                if (!sourceId || sourceId === reorderId || !(target instanceof Element)) {
                  return;
                }
                event.preventDefault();
                const placement = panelTabDropPlacement(event, target);
                finishPanelTabDrag(target);
                params.onReorder(sourceId, reorderId, placement);
              }}
              @dragend=${(event: DragEvent) => {
                if (event.currentTarget instanceof Element) {
                  finishPanelTabDrag(event.currentTarget);
                }
              }}
            >
              ${
                tab.labelTooltip
                  ? html`<openclaw-tooltip
                      class="tabstrip-tab__label-tooltip"
                      .content=${tab.labelTooltip}
                    >
                      <span class="tabstrip-tab__tooltip-trigger">${tabContent}</span>
                    </openclaw-tooltip>`
                  : tabContent
              }
            </wa-tab>
            <button
              id=${`${tab.domId}-close`}
              slot="nav"
              class="rail-header__action tabstrip-tab__close"
              type="button"
              .tabIndex=${selected ? 0 : -1}
              aria-label=${tab.closeLabel}
              @keydown=${(event: KeyboardEvent) => {
                if (
                  (event.key === "Enter" || event.key === " ") &&
                  event.currentTarget instanceof Element
                ) {
                  keyboardCloseActivations.add(event.currentTarget);
                }
              }}
              @click=${async (event: MouseEvent) => {
                const button = event.currentTarget;
                const renderRoot =
                  button instanceof Node ? (button.getRootNode() as ParentNode) : null;
                const renderHost =
                  renderRoot instanceof ShadowRoot
                    ? (renderRoot.host as HTMLElement & { updateComplete?: Promise<unknown> })
                    : null;
                const restoreFocus =
                  button instanceof Element &&
                  (keyboardCloseActivations.delete(button) || activeElementFor(button) === button);
                await params.onClose(tab.id);
                if (!restoreFocus) {
                  return;
                }
                await renderHost?.updateComplete;
                const settledGroup = [
                  ...(renderRoot?.querySelectorAll<
                    HTMLElement & { updateComplete?: Promise<unknown> }
                  >("wa-tab-group") ?? []),
                ].find((candidate) =>
                  [...candidate.querySelectorAll<HTMLElement>("wa-tab")].some((renderedTab) =>
                    params.tabs.some(
                      (entry) => renderedTab.getAttribute("aria-controls") === controlsFor(entry),
                    ),
                  ),
                );
                await settledGroup?.updateComplete;
                const closingTab = [
                  ...(settledGroup?.querySelectorAll<HTMLElement>("wa-tab") ?? []),
                ].find((candidate) => candidate.getAttribute("panel") === tab.id);
                const fallback = settledGroup?.querySelector<HTMLElement>("wa-tab[active]");
                const current = fallback ? activeElementFor(fallback) : null;
                if (!closingTab && fallback && focusNeedsRecovery(fallback, current)) {
                  fallback.focus({ preventScroll: true });
                }
              }}
            >
              <span class="tabstrip-tab__close-box">${icons.x}</span>
            </button>
            ${
              showSeparator
                ? html`<span slot="nav" class="tabstrip-separator" aria-hidden="true"></span>`
                : nothing
            }
          `;
        },
      )}
      ${newButton(true)}
    </wa-tab-group>
    <!-- WA's nav slot owns visual layout; action buttons belong beside the tablist in the accessibility tree. -->
    <span
      role="group"
      style="display: contents"
      aria-owns=${[
        ...params.tabs.map((tab) => `${tab.domId}-close`),
        ...(params.newControl === nothing ? [] : [newControlId]),
      ].join(" ")}
    ></span>
  `;
}

export const panelTabStripStyles = css`
  :where(.tp-header, .bp-header) {
    --rail-header-height: 46px;
    --rail-header-padding-start: 8px;
  }
  :where(.tp-actions, .bp-actions) {
    padding-left: 8px;
    border-left: 1px solid var(--border, #262b34);
  }
  .tabstrip {
    --track-width: 0;
    display: block;
    /* Allow the strip to shrink inside a flex header so wide tab rows scroll
       here instead of squeezing out sibling header controls. */
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tabstrip::part(nav) {
    display: flex;
    align-items: center;
  }
  .tabstrip::part(body) {
    display: none;
  }
  .tabstrip::-webkit-scrollbar {
    display: none;
  }
  .tabstrip-tab::part(base) {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 30px;
    padding: 0 34px 0 10px;
    border: 0;
    border-radius: 7px;
    color: var(--muted, #8a919e);
    white-space: nowrap;
    font-size: 12.5px;
    transition:
      color 0.12s ease,
      background 0.12s ease,
      box-shadow 0.12s ease;
  }
  .tabstrip-tab:hover::part(base) {
    color: var(--text, #d7dae0);
    background: color-mix(in srgb, var(--text, #d7dae0) 6%, transparent);
  }
  .tabstrip-tab[active]::part(base) {
    color: var(--text, #d7dae0);
    background: var(--bg-hover, #1f2330);
    box-shadow: inset 0 0 0 1px var(--border-strong, #2e3040);
  }
  .tabstrip-tab.is-exited:not([active])::part(base) {
    opacity: 0.55;
  }
  .tabstrip-tab.is-connecting .tabstrip-tab__icon {
    animation: tabstrip-pulse 1.2s ease-in-out infinite;
  }
  .tabstrip-tab__icon {
    display: inline-flex;
    color: var(--accent, #ff5c5c);
  }
  .tabstrip-tab__favicon {
    width: 16px;
    height: 16px;
    border-radius: 3px;
    object-fit: contain;
  }
  .tabstrip-tab.is-exited .tabstrip-tab__icon {
    color: var(--muted, #8a919e);
  }
  .tabstrip-tab__label {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }
  .tabstrip-tab__tooltip-trigger {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    gap: inherit;
    flex: 1 1 auto;
  }
  .tabstrip-tab__status {
    font-size: 11px;
    color: var(--muted, #8a919e);
  }
  .tabstrip-tab__badge {
    border: 1px solid color-mix(in srgb, var(--accent, #ff5c5c) 45%, transparent);
    border-radius: 999px;
    color: var(--accent, #ff5c5c);
    font-size: 9px;
    line-height: 14px;
    padding: 0 5px;
    text-transform: uppercase;
  }
  /* Keep the close action inside the tab surface without nesting it in wa-tab;
     wa-tab-group still owns the direct tab children for keyboard navigation. */
  .tabstrip-tab__close {
    flex: 0 0 auto;
    align-self: center;
    z-index: 1;
    margin-left: -32px;
    margin-right: 4px;
    opacity: 0;
    transition: opacity 0.12s ease;
  }
  .tabstrip-tab__close-box {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 5px;
  }
  :where(.tabstrip-tab:hover, .tabstrip-tab[active]) + .tabstrip-tab__close,
  .tabstrip-tab__close:hover,
  .tabstrip-tab__close:focus-visible {
    opacity: 1;
  }
  .tabstrip-new {
    flex: none;
    align-self: center;
    margin-left: 2px;
  }
  .tabstrip-new-control {
    display: inline-flex;
    flex: none;
    align-self: center;
  }
  .tabstrip-separator {
    flex: 0 0 auto;
    align-self: center;
  }
  @keyframes tabstrip-pulse {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .tabstrip-tab.is-connecting .tabstrip-tab__icon {
      animation: none;
    }
  }
`;
