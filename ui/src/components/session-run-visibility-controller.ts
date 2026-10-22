import { onCleanup } from "solid-js";

type VisibilityGroup = {
  observer: IntersectionObserver;
  rows: Map<Element, Map<Element, (offscreen: boolean) => void>>;
};

const groups = new WeakMap<Element, VisibilityGroup>();

function visibilityGroup(root: Element): VisibilityGroup {
  let group = groups.get(root);
  if (!group) {
    const rows = new Map<Element, Map<Element, (offscreen: boolean) => void>>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          for (const notify of rows.get(entry.target)?.values() ?? []) {
            // Edge contact already intersects at threshold zero; entering further may not notify.
            notify(!entry.isIntersecting);
          }
        }
      },
      { root },
    );
    group = { observer, rows };
    groups.set(root, group);
  }
  return group;
}

export function createSessionRunVisibility(
  onOffscreenChange: (offscreen: boolean) => void,
): (element: Element) => void {
  let current: Element | undefined;
  let observation: { root: Element; row: Element; group: VisibilityGroup } | undefined;
  let pending = false;

  const release = () => {
    if (!observation || !current) {
      return;
    }
    const { root, row, group } = observation;
    const indicators = group.rows.get(row);
    indicators?.delete(current);
    if (indicators?.size === 0) {
      group.observer.unobserve(row);
      group.rows.delete(row);
    }
    if (group.rows.size === 0) {
      group.observer.disconnect();
      groups.delete(root);
    }
    observation = undefined;
  };
  onCleanup(() => {
    release();
    current = undefined;
  });

  return (next) => {
    if (current !== next) {
      release();
      current = next;
    }
    if (pending) {
      return;
    }
    pending = true;
    // Child-owned rows attach after the sidebar updates; wait for this template's commit.
    queueMicrotask(() => {
      pending = false;
      const element = current;
      if (!element?.isConnected) {
        return;
      }
      const row = element.closest(".session-row-host");
      const root = element.closest(".sidebar-shell__body");
      if (!row || !root) {
        return;
      }
      if (observation?.root !== root || observation.row !== row) {
        release();
        const group = visibilityGroup(root);
        const indicators = group.rows.get(row) ?? new Map<Element, (offscreen: boolean) => void>();
        indicators.set(element, onOffscreenChange);
        group.rows.set(row, indicators);
        observation = { root, row, group };
        // A new indicator needs native delivery even when this row is already observed.
        group.observer.unobserve(row);
        group.observer.observe(row);
      }
    });
  };
}
