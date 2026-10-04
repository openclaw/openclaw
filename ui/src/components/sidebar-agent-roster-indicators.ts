import { nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";
import "./tooltip.ts";

// The session renderers own the facts and their accessible copy. This projection
// only fits their rendered indicators around the agent identity.
class RosterHeaderIndicatorsDirective extends AsyncDirective {
  private header?: HTMLElement;
  private resize?: ResizeObserver;
  private mutations?: MutationObserver;
  private frame?: number;
  private label = "";

  render(_label: string) {
    return nothing;
  }

  override update(part: ElementPart, [label]: [string]) {
    this.header = part.element instanceof HTMLElement ? part.element : undefined;
    this.label = label;
    this.schedule();
    return nothing;
  }

  protected override reconnected() {
    this.schedule();
  }

  protected override disconnected() {
    this.resize?.disconnect();
    this.mutations?.disconnect();
    this.resize = undefined;
    this.mutations = undefined;
    if (this.frame !== undefined) {
      cancelAnimationFrame(this.frame);
      this.frame = undefined;
    }
  }

  private readonly schedule = () => {
    if (this.frame === undefined && this.isConnected) {
      this.frame = requestAnimationFrame(() => {
        this.frame = undefined;
        this.layout();
      });
    }
  };

  private layout() {
    const header = this.header;
    if (!header?.isConnected || !this.isConnected) {
      return;
    }
    const signals = header.querySelector<HTMLElement>(".sidebar-agent-roster__signals")!;
    const row = header.querySelector<HTMLAnchorElement>(".sidebar-agent-roster__row")!;
    const name = header.querySelector<HTMLElement>(".sidebar-agent-roster__copy > span")!;
    const overflow = header.querySelector<HTMLElement>(".sidebar-agent-roster__overflow")!;
    const tooltip = header.querySelector<HTMLElementTagNameMap["openclaw-tooltip"]>(
      "openclaw-tooltip.sidebar-agent-roster__tooltip",
    )!;
    if (!this.resize) {
      this.resize = new ResizeObserver(this.schedule);
      this.resize.observe(header);
      this.resize.observe(name);
      this.resize.observe(signals);
      this.mutations = new MutationObserver(this.schedule);
      this.mutations.observe(signals, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["aria-label", "title"],
      });
    }

    const labels = new Set<string>();
    for (const element of signals.querySelectorAll<HTMLElement>("[aria-label], [title]")) {
      const label = element.getAttribute("aria-label");
      const count = element.textContent?.trim() ?? "";
      if (label) {
        labels.add(/^\d+$/.test(count) && !label.includes(count) ? `${label}: ${count}` : label);
      }
      if (element.title && element.title !== label) {
        labels.add(element.title);
      }
    }
    const description = [this.label, ...labels].join(" · ");
    tooltip.anchor = row;
    tooltip.content = description;
    row.setAttribute("aria-label", description);
    for (const nested of signals.querySelectorAll("openclaw-tooltip")) {
      nested.disabled = true;
    }
    for (const focusable of signals.querySelectorAll<HTMLElement>("[tabindex]")) {
      focusable.tabIndex = -1;
    }

    const status = signals.querySelector<HTMLElement>(".sidebar-session-team-state__status");
    const unread = signals.querySelector<HTMLElement>(".session-unread-dot");
    const avatarBadge = status ?? unread;
    for (const previous of signals.querySelectorAll(".sidebar-agent-roster__avatar-badge")) {
      if (previous !== avatarBadge) {
        previous.classList.remove("sidebar-agent-roster__avatar-badge");
      }
    }
    if (avatarBadge) {
      avatarBadge.hidden = false;
      avatarBadge.classList.remove("sidebar-agent-roster__indicator");
      avatarBadge.classList.add("sidebar-agent-roster__avatar-badge");
    }

    const items: HTMLElement[] = [];
    const collect = (container: Element) => {
      for (const child of container.children) {
        if (!(child instanceof HTMLElement) || child === avatarBadge) {
          continue;
        }
        if (
          child.matches(
            ".sidebar-recent-session__details-endcap, .session-row-badges, .sidebar-session-team-state, .sidebar-session-team-state__counts",
          )
        ) {
          collect(child);
        } else if (
          !child.matches("openclaw-viewer-facepile") ||
          child.querySelector(".viewer-facepile")
        ) {
          items.push(child);
        } else {
          child.classList.remove("sidebar-agent-roster__indicator");
          child.hidden = false;
          child.style.removeProperty("order");
        }
      }
    };
    collect(signals);
    const priority = (item: HTMLElement) =>
      item.querySelector(".session-row-badge--attention, .session-row-badge--approval")
        ? 0
        : item.matches(".sidebar-session-indicator, openclaw-viewer-facepile")
          ? 1
          : item.matches(".sidebar-session-fork-indicator") ||
              item.querySelector(".session-row-badge--pull-request")
            ? 2
            : item.querySelector(".session-row-badge--incognito, .session-row-badge--draft")
              ? 4
              : 3;
    items.sort((left, right) => priority(left) - priority(right));
    for (const item of items) {
      item.hidden = false;
      item.classList.add("sidebar-agent-roster__indicator");
      item.style.order = String(priority(item));
    }
    // Measure intrinsic widths before reserving the right edge of the link.
    // A long name evicts optional indicators before it is allowed to ellipsize.
    const gap = Number.parseFloat(getComputedStyle(signals).columnGap) || 0;
    const widths = items.map((item) => item.getBoundingClientRect().width);
    const nameRange = header.ownerDocument.createRange();
    nameRange.selectNodeContents(name);
    const nameWidth = nameRange.getBoundingClientRect().width;
    const rowWidth = row.getBoundingClientRect().width;
    const avatar = header.querySelector<HTMLElement>(".sidebar-agent-roster__avatar")!;
    const rowStyle = getComputedStyle(row);
    const identityWidth =
      avatar.getBoundingClientRect().width +
      Number.parseFloat(rowStyle.columnGap) +
      Number.parseFloat(rowStyle.paddingInlineStart) +
      4;
    const available = Math.max(0, rowWidth - identityWidth - nameWidth - gap);
    const total =
      widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, items.length - 1);
    overflow.hidden = true;
    let used = total;
    if (total > available) {
      overflow.hidden = false;
      overflow.textContent = `+${items.length}`;
      used = overflow.getBoundingClientRect().width;
      let hidden = 0;
      items.forEach((item, index) => {
        const width = widths[index]! + gap;
        const fits = used + width <= available;
        item.hidden = priority(item) !== 0 && !fits;
        if (item.hidden) {
          hidden++;
        } else {
          used += width;
        }
      });
      overflow.textContent = `+${hidden}`;
      overflow.hidden = hidden === 0;
      if (hidden === 0) {
        used = total;
      }
    }
    header.style.setProperty(
      "--roster-overflow-width",
      overflow.hidden ? "0px" : `${overflow.getBoundingClientRect().width + gap}px`,
    );
    row.style.paddingInlineEnd = used > 0 ? `${used + gap + 4}px` : "0px";
  }
}

export const rosterHeaderIndicators = directive(RosterHeaderIndicatorsDirective);
