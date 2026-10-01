import { nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";

type VisibilityGroup = {
  observer: IntersectionObserver;
  rows: Map<Element, Set<Element>>;
};

const groups = new WeakMap<Element, VisibilityGroup>();

function visibilityGroup(root: Element): VisibilityGroup {
  let group = groups.get(root);
  if (!group) {
    const rows = new Map<Element, Set<Element>>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          for (const indicator of rows.get(entry.target) ?? []) {
            // Edge contact already intersects at threshold zero; entering further may not notify.
            indicator.classList.toggle("session-run-indicator--offscreen", !entry.isIntersecting);
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

class SessionRunVisibility extends AsyncDirective {
  private element?: Element;
  private observation?: { root: Element; row: Element; group: VisibilityGroup };
  private pending = false;

  render() {
    return nothing;
  }

  override update(part: ElementPart) {
    this.element = part.element;
    this.schedule();
    return nothing;
  }

  private schedule() {
    if (this.pending || !this.isConnected) {
      return;
    }
    this.pending = true;
    // Child-owned rows attach after the sidebar updates; wait for this template's commit.
    queueMicrotask(() => {
      this.pending = false;
      const element = this.element;
      if (!this.isConnected || !element?.isConnected) {
        return;
      }
      const row = element.closest(".session-row-host");
      const root = element.closest(".sidebar-shell__body");
      if (!row || !root) {
        return;
      }
      if (this.observation?.root !== root || this.observation.row !== row) {
        this.disconnected();
        const group = visibilityGroup(root);
        const indicators = group.rows.get(row) ?? new Set<Element>();
        indicators.add(element);
        group.rows.set(row, indicators);
        this.observation = { root, row, group };
      }
      // A queued-state class binding can replace the paused class without moving the row.
      // Reobserve so only native visibility delivery restores it after the completed render.
      this.observation.group.observer.unobserve(row);
      this.observation.group.observer.observe(row);
    });
  }

  protected override disconnected() {
    if (!this.observation || !this.element) {
      return;
    }
    const { root, row, group } = this.observation;
    const indicators = group.rows.get(row);
    indicators?.delete(this.element);
    if (indicators?.size === 0) {
      group.observer.unobserve(row);
      group.rows.delete(row);
    }
    if (group.rows.size === 0) {
      group.observer.disconnect();
      groups.delete(root);
    }
    this.observation = undefined;
  }

  protected override reconnected() {
    this.schedule();
  }
}

export const sessionRunVisibility = directive(SessionRunVisibility);
