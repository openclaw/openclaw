import type { JSX } from "@solidjs/web";
import { For, Show, createEffect, createMemo, flush, onSettled, untrack } from "solid-js";
import type { PanelTabStripTab } from "./panel-tab-strip-types.ts";
import { Icon } from "./solid/icon.tsx";
import "./tooltip.ts";
import "./web-awesome-tabs.ts";

export type SolidPanelTabStripTab = Omit<PanelTabStripTab, "icon"> & { icon?: JSX.Element };
export type PanelTabStripProps<T extends SolidPanelTabStripTab> = {
  tabs: T[];
  activeId: string | null;
  ariaControls: string | ((tab: T) => string);
  onSelect: (id: string) => void;
  onClose: (id: string) => void | Promise<void>;
  onNew: () => void;
  newLabel: string;
  newDisabled?: boolean;
  newTabAction?: boolean;
  /** null hides the control; undefined renders the default new-tab button. */
  newControl?: JSX.Element;
  separateTabs?: boolean;
  onReorder?: (sourceId: string, targetId: string, placement: "before" | "after") => void;
};

const PANEL_TAB_DRAG_TYPE = "application/x-openclaw-panel-tab";
const keyboardCloseActivations = new WeakSet<Element>();
type TabGroup = HTMLElement & { updateComplete: Promise<unknown> };

function clearDropTargets(element: Element): void {
  element
    .closest("wa-tab-group")
    ?.querySelectorAll(".is-drop-before, .is-drop-after")
    .forEach((target) => target.classList.remove("is-drop-before", "is-drop-after"));
}

function finishDrag(element: Element): void {
  clearDropTargets(element);
  element.closest("wa-tab-group")?.removeAttribute("data-dragged-panel-tab");
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

/** Array order's leading edge is the physical right edge under RTL. */
function dropPlacement(event: DragEvent, target: Element): "before" | "after" {
  const bounds = target.getBoundingClientRect();
  const pastMidpoint = event.clientX > bounds.left + bounds.width / 2;
  return pastMidpoint === (getComputedStyle(target).direction === "rtl") ? "before" : "after";
}

function NewControl<T extends SolidPanelTabStripTab>(props: {
  strip: PanelTabStripProps<T>;
  slotted: boolean;
}) {
  const id = () => (props.strip.tabs[0] ? `${props.strip.tabs[0].domId}-new` : undefined);
  return (
    <Show when={props.strip.newControl !== null}>
      <Show
        when={props.strip.newControl !== undefined}
        fallback={
          <button
            id={id()}
            slot={props.slotted ? "nav" : undefined}
            class="rail-header__action tabstrip-new"
            type="button"
            data-new-tab-action={props.strip.newTabAction ? "" : undefined}
            disabled={props.strip.newDisabled}
            title={props.strip.newLabel}
            aria-label={props.strip.newLabel}
            onClick={() => props.strip.onNew()}
          >
            <Icon name="plus" />
          </button>
        }
      >
        <span id={id()} slot={props.slotted ? "nav" : undefined} class="tabstrip-new-control">
          {props.strip.newControl}
        </span>
      </Show>
    </Show>
  );
}

function TabGroupView<T extends SolidPanelTabStripTab>(props: PanelTabStripProps<T>) {
  let group!: TabGroup;
  let scheduleMeasurement = () => {};
  const controlsFor = (tab: T) =>
    typeof props.ariaControls === "string" ? props.ariaControls : props.ariaControls(tab);
  const layoutKey = createMemo(() =>
    JSON.stringify([props.activeId, props.tabs.map((tab) => tab.id)]),
  );
  const measurementKey = createMemo(() =>
    JSON.stringify([layoutKey(), props.tabs.map((tab) => tab.className)]),
  );

  onSettled(() => {
    let disposed = false;
    let scroller: HTMLElement | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let observed = new Set<Element>();
    let frame: number | undefined;
    const schedule = () => {
      if (frame !== undefined || disposed || !scroller) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (disposed || !group.isConnected || !scroller) {
          return;
        }
        const children = [...group.children];
        const labels = [...group.querySelectorAll<HTMLElement>(".tabstrip-tab__label")];
        const nextObserved = new Set<Element>([scroller, ...children, ...labels]);
        for (const target of observed) {
          if (!nextObserved.has(target)) {
            resizeObserver?.unobserve(target);
          }
        }
        for (const target of nextObserved) {
          if (!observed.has(target)) {
            resizeObserver?.observe(target);
          }
        }
        observed = nextObserved;
        // Read the row together before overflow classes can dirty layout.
        const overflow = labels.map((label) => ({
          label,
          overflowing: label.scrollWidth > label.clientWidth + 1,
        }));
        const rects = children.map((child) => child.getBoundingClientRect());
        const viewport = scroller.getBoundingClientRect();
        // Physical rects handle both directions without scrollLeft normalization.
        const left = rects.some((rect) => viewport.left - rect.left > 8);
        const right = rects.some((rect) => rect.right - viewport.right > 8);
        for (const { label, overflowing } of overflow) {
          label.classList.toggle("is-overflowing", overflowing);
          label.parentElement?.classList.toggle("has-label-overflow", overflowing);
          label.toggleAttribute("data-tooltip-overflow", overflowing);
        }
        group.classList.toggle("has-scroll-left", left);
        group.classList.toggle("has-scroll-right", right);
      });
    };
    scheduleMeasurement = schedule;
    // Label text can overflow without changing its observed width.
    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(group, { childList: true, characterData: true, subtree: true });
    void group.updateComplete.then(() => {
      if (disposed || !group.isConnected) {
        return;
      }
      scroller = group.shadowRoot?.querySelector<HTMLElement>('[part~="tabs"]') ?? undefined;
      scroller?.addEventListener("scroll", schedule, { passive: true });
      if (typeof ResizeObserver === "function") {
        resizeObserver = new ResizeObserver(schedule);
        if (scroller) {
          resizeObserver.observe(scroller);
          observed.add(scroller);
        }
      }
      schedule();
    });
    return () => {
      disposed = true;
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      scroller?.removeEventListener("scroll", schedule);
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
      }
    };
  });

  createEffect(
    () => [measurementKey(), document.documentElement.dir],
    () => scheduleMeasurement(),
  );
  createEffect(
    () => ({ key: layoutKey(), focusedId: deepestActiveElementId() }),
    ({ focusedId }) => {
      const tabs = [
        ...group.querySelectorAll<HTMLElement & { updateComplete: Promise<unknown> }>("wa-tab"),
      ];
      // A new WA tab resets tabIndex during its first update even when the group's
      // active tab stays unchanged. Reconcile after both owners have committed.
      void Promise.all([group.updateComplete, ...tabs.map((tab) => tab.updateComplete)]).then(
        () => {
          if (!group.isConnected) {
            return;
          }
          const activeId = untrack(() => props.activeId);
          const currentTabs = [...group.querySelectorAll<HTMLElement>("wa-tab")];
          const selected = currentTabs.find((tab) => tab.getAttribute("panel") === activeId);
          for (const tab of currentTabs) {
            tab.tabIndex = tab === selected ? 0 : -1;
          }
          if (!selected) {
            return;
          }
          // Recover only focus lost by keyed movement, never newer user focus.
          selected.scrollIntoView?.({ block: "nearest", inline: "nearest" });
          if (
            focusedId === selected.id &&
            focusNeedsRecovery(selected, activeElementFor(selected))
          ) {
            selected.focus({ preventScroll: true });
          }
        },
      );
    },
  );

  async function closeTab(event: MouseEvent, tab: T) {
    const button = event.currentTarget;
    const root = button instanceof Node ? button.getRootNode() : null;
    const renderRoot = root instanceof Document || root instanceof ShadowRoot ? root : null;
    const restoreFocus =
      button instanceof Element &&
      (keyboardCloseActivations.delete(button) || activeElementFor(button) === button);
    await props.onClose(tab.id);
    if (!restoreFocus) {
      return;
    }
    // The owning callback mutates its domain owner; commit its projection before
    // asking Web Awesome which surviving tab is active.
    flush();
    const settledGroup = [...(renderRoot?.querySelectorAll<TabGroup>("wa-tab-group") ?? [])].find(
      (candidate) =>
        [...candidate.querySelectorAll<HTMLElement>("wa-tab")].some((renderedTab) =>
          props.tabs.some(
            (entry) => renderedTab.getAttribute("aria-controls") === controlsFor(entry),
          ),
        ),
    );
    await settledGroup?.updateComplete;
    const closingTab = [...(settledGroup?.querySelectorAll<HTMLElement>("wa-tab") ?? [])].find(
      (candidate) => candidate.getAttribute("panel") === tab.id,
    );
    const fallback = settledGroup?.querySelector<HTMLElement>("wa-tab[active]");
    if (!closingTab && fallback && focusNeedsRecovery(fallback, activeElementFor(fallback))) {
      fallback.focus({ preventScroll: true });
    }
  }

  return (
    <>
      <wa-tab-group
        ref={(element: TabGroup) => {
          group = element;
        }}
        class="tabstrip"
        prop:active={props.activeId ?? ""}
        activation="auto"
        without-scroll-controls
        onWa-tab-show={(event: CustomEvent<{ name: string }>) => {
          if (event.detail.name !== props.activeId) {
            props.onSelect(event.detail.name);
          }
        }}
      >
        <For each={props.tabs} keyed={(tab) => tab.id}>
          {(tab, index) => {
            const selected = () => tab().id === props.activeId;
            const reorderId = () => tab().reorderId ?? tab().id;
            const draggable = () => Boolean(props.onReorder) && tab().draggable !== false;
            const handleDrag = (event: DragEvent) => {
              const target = event.currentTarget;
              if (!props.onReorder || !event.dataTransfer || !(target instanceof Element)) {
                return;
              }
              const dropping = event.type === "drop";
              const sourceId =
                target.closest<HTMLElement>("wa-tab-group")?.dataset.draggedPanelTab ||
                (dropping ? event.dataTransfer.getData(PANEL_TAB_DRAG_TYPE) : "");
              if (!sourceId || sourceId === reorderId()) {
                return;
              }
              event.preventDefault();
              if (dropping) {
                const placement = dropPlacement(event, target);
                finishDrag(target);
                props.onReorder(sourceId, reorderId(), placement);
              } else {
                event.dataTransfer.dropEffect = "move";
                clearDropTargets(target);
                target.classList.add(`is-drop-${dropPlacement(event, target)}`);
              }
            };
            const content = () => (
              <>
                <Show when={tab().icon != null}>
                  <span class="tabstrip-tab__icon" aria-hidden="true">
                    {tab().icon}
                  </span>
                </Show>
                <span class="tabstrip-tab__label">{tab().label}</span>
                <Show when={tab().badge}>
                  <span class="tabstrip-tab__badge">{tab().badge}</span>
                </Show>
                <Show when={tab().statusLabel}>
                  <span class="tabstrip-tab__status">{tab().statusLabel}</span>
                </Show>
              </>
            );
            return (
              <>
                <wa-tab
                  ref={(element) => {
                    // Intercept explicit activation before WA's native group listeners.
                    element.addEventListener("click", (event) => {
                      if (tab().onActivate) {
                        event.stopPropagation();
                        tab().onActivate?.();
                      }
                    });
                    element.addEventListener("keydown", (event) => {
                      if (tab().onActivate && (event.key === "Enter" || event.key === " ")) {
                        event.preventDefault();
                        event.stopPropagation();
                        if (!event.repeat) {
                          tab().onActivate?.();
                        }
                      }
                    });
                  }}
                  id={tab().domId}
                  class={["tabstrip-tab", tab().className]}
                  panel={tab().id}
                  aria-controls={controlsFor(tab())}
                  aria-selected={selected() ? "true" : "false"}
                  title={tab().title || undefined}
                  prop:active={selected()}
                  draggable={draggable() ? "true" : undefined}
                  prop:tabIndex={selected() ? 0 : -1}
                  onAuxClick={(event: MouseEvent) => {
                    if (event.button === 1) {
                      event.preventDefault();
                      void props.onClose(tab().id);
                    }
                  }}
                  onDragStart={(event: DragEvent) => {
                    if (!draggable() || !event.dataTransfer) {
                      return;
                    }
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData(PANEL_TAB_DRAG_TYPE, reorderId());
                    if (event.currentTarget instanceof Element) {
                      const currentGroup = event.currentTarget.closest<HTMLElement>("wa-tab-group");
                      if (currentGroup) {
                        currentGroup.dataset.draggedPanelTab = reorderId();
                      }
                    }
                  }}
                  onDragOver={handleDrag}
                  onDragLeave={(event: DragEvent) => {
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
                  onDrop={handleDrag}
                  onDragEnd={(event: DragEvent) => {
                    if (event.currentTarget instanceof Element) {
                      finishDrag(event.currentTarget);
                    }
                  }}
                >
                  <Show when={tab().labelTooltip} fallback={content()}>
                    <openclaw-tooltip
                      class="tabstrip-tab__label-tooltip"
                      prop:content={tab().labelTooltip ?? ""}
                    >
                      <span class="tabstrip-tab__tooltip-trigger">{content()}</span>
                    </openclaw-tooltip>
                  </Show>
                </wa-tab>
                <button
                  id={`${tab().domId}-close`}
                  slot="nav"
                  class="rail-header__action tabstrip-tab__close"
                  type="button"
                  tabindex={selected() ? 0 : -1}
                  aria-label={tab().closeLabel}
                  onKeyDown={(event: KeyboardEvent) => {
                    if (
                      (event.key === "Enter" || event.key === " ") &&
                      event.currentTarget instanceof Element
                    ) {
                      keyboardCloseActivations.add(event.currentTarget);
                    }
                  }}
                  onClick={(event: MouseEvent) => void closeTab(event, tab())}
                >
                  <span class="tabstrip-tab__close-box">
                    <Icon name="x" />
                  </span>
                </button>
                <Show
                  when={
                    props.separateTabs === true &&
                    index() < props.tabs.length - 1 &&
                    (tab().group === undefined || tab().group !== props.tabs[index() + 1]?.group)
                  }
                >
                  <span slot="nav" class="tabstrip-separator" aria-hidden="true" />
                </Show>
              </>
            );
          }}
        </For>
        <NewControl strip={props} slotted />
      </wa-tab-group>
      {/* WA owns visual layout; actions belong beside the tablist in the accessibility tree. */}
      <span
        role="group"
        style={{ display: "contents" }}
        aria-owns={[
          ...props.tabs.map((tab) => `${tab.domId}-close`),
          ...(props.newControl === null ? [] : [`${props.tabs[0]?.domId}-new`]),
        ].join(" ")}
      />
    </>
  );
}

export function PanelTabStrip<T extends SolidPanelTabStripTab>(props: PanelTabStripProps<T>) {
  // WA dereferences its first tab when an empty group becomes visible.
  return (
    <Show when={props.tabs.length > 0} fallback={<NewControl strip={props} slotted={false} />}>
      <TabGroupView {...props} />
    </Show>
  );
}
