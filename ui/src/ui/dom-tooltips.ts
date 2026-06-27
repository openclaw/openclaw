const TITLE_TOOLTIP_SELECTOR =
  "button[title], .btn[title], button[data-tooltip], .btn[data-tooltip]";
const PROMOTED_TITLE_ATTR = "data-native-tooltip-title";
const GENERATED_TOOLTIP_ATTR = "data-native-tooltip-generated";
const GENERATED_ARIA_LABEL_ATTR = "data-native-tooltip-generated-aria-label";
const GENERATED_ARIA_DESCRIBEDBY_ATTR = "data-native-tooltip-generated-aria-describedby";
const ACTIVE_FLOATING_TOOLTIP_ATTR = "data-floating-tooltip-active";
const FLOATING_TOOLTIP_CLASS = "control-ui-floating-tooltip";
const FLOATING_TOOLTIP_ID = "control-ui-floating-tooltip";

type FloatingTooltipTrigger = "focus" | "pointer";

// Pointer and focus activation can overlap. Restore native title state only
// after the last active trigger leaves the element.
const activeFloatingTooltipTriggers = new WeakMap<HTMLElement, Set<FloatingTooltipTrigger>>();
const renderPreparedFloatingTooltips = new WeakSet<HTMLElement>();
let activeFloatingTooltipOwner: HTMLElement | null = null;
let activeFloatingTooltipRoot: ParentNode | null = null;

function refreshFloatingTooltipForViewportChange() {
  if (activeFloatingTooltipRoot) {
    refreshActiveFloatingTooltip(activeFloatingTooltipRoot);
  }
}

function stopFloatingTooltipViewportTracking() {
  if (!activeFloatingTooltipRoot) {
    return;
  }
  window.removeEventListener("scroll", refreshFloatingTooltipForViewportChange, true);
  window.removeEventListener("resize", refreshFloatingTooltipForViewportChange);
  activeFloatingTooltipRoot = null;
}

function startFloatingTooltipViewportTracking(root: ParentNode) {
  if (activeFloatingTooltipRoot === root) {
    return;
  }
  stopFloatingTooltipViewportTracking();
  activeFloatingTooltipRoot = root;
  window.addEventListener("scroll", refreshFloatingTooltipForViewportChange, true);
  window.addEventListener("resize", refreshFloatingTooltipForViewportChange);
}

function tooltipRootContains(root: ParentNode, element: Element): boolean {
  return root instanceof Node && root.contains(element);
}

function resolveTitleTooltipTarget(
  target: EventTarget | null,
  root: ParentNode,
): HTMLElement | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const element = target.closest<HTMLElement>(TITLE_TOOLTIP_SELECTOR);
  if (!element || !tooltipRootContains(root, element)) {
    return null;
  }
  return element;
}

function resolvePromotedTooltipTarget(
  target: EventTarget | null,
  root: ParentNode,
): HTMLElement | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const element = target.closest<HTMLElement>(
    `[${ACTIVE_FLOATING_TOOLTIP_ATTR}], [${PROMOTED_TITLE_ATTR}]`,
  );
  if (!element || !tooltipRootContains(root, element)) {
    return null;
  }
  return element;
}

function getTooltipText(element: HTMLElement): string {
  if (element.getAttribute(GENERATED_TOOLTIP_ATTR) === "true") {
    return element.getAttribute("title") || element.getAttribute("data-tooltip") || "";
  }
  return element.getAttribute("data-tooltip") || element.getAttribute("title") || "";
}

function restorePromotedTooltipTitle(element: HTMLElement) {
  const title = element.getAttribute(PROMOTED_TITLE_ATTR);
  if (title) {
    element.setAttribute("title", title);
  } else {
    element.removeAttribute("title");
  }
  element.removeAttribute(PROMOTED_TITLE_ATTR);
}

function ensurePromotedTooltipAccessibleName(element: HTMLElement, title: string | null) {
  if (!title) {
    return;
  }
  if (element.getAttribute(GENERATED_ARIA_LABEL_ATTR) === "true") {
    element.setAttribute("aria-label", title);
    return;
  }
  const hasAccessibleNameWithoutTitle =
    element.hasAttribute("aria-label") ||
    element.hasAttribute("aria-labelledby") ||
    Boolean(element.textContent?.trim()) ||
    Boolean(element.querySelector("[aria-label], [aria-labelledby], img[alt]:not([alt=''])"));
  if (hasAccessibleNameWithoutTitle) {
    return;
  }
  element.setAttribute("aria-label", title);
  element.setAttribute(GENERATED_ARIA_LABEL_ATTR, "true");
}

function restorePromotedTooltipAccessibleName(element: HTMLElement) {
  if (element.getAttribute(GENERATED_ARIA_LABEL_ATTR) !== "true") {
    return;
  }
  element.removeAttribute("aria-label");
  element.removeAttribute(GENERATED_ARIA_LABEL_ATTR);
}

function clearGeneratedTooltipMetadata(element: HTMLElement) {
  if (element.getAttribute(GENERATED_TOOLTIP_ATTR) !== "true") {
    return;
  }
  element.removeAttribute("data-tooltip");
  element.removeAttribute(GENERATED_TOOLTIP_ATTR);
}

function ensureFloatingTooltipDescription(element: HTMLElement, tooltip: HTMLElement) {
  const describedBy = element.getAttribute("aria-describedby")?.split(/\s+/).filter(Boolean) ?? [];
  if (describedBy.includes(tooltip.id)) {
    return;
  }
  element.setAttribute("aria-describedby", [...describedBy, tooltip.id].join(" "));
  element.setAttribute(GENERATED_ARIA_DESCRIBEDBY_ATTR, "true");
}

function restoreFloatingTooltipDescription(element: HTMLElement) {
  if (element.getAttribute(GENERATED_ARIA_DESCRIBEDBY_ATTR) !== "true") {
    return;
  }
  const describedBy =
    element
      .getAttribute("aria-describedby")
      ?.split(/\s+/)
      .filter((id) => id && id !== FLOATING_TOOLTIP_ID) ?? [];
  if (describedBy.length > 0) {
    element.setAttribute("aria-describedby", describedBy.join(" "));
  } else {
    element.removeAttribute("aria-describedby");
  }
  element.removeAttribute(GENERATED_ARIA_DESCRIBEDBY_ATTR);
}

function getFloatingTooltip(): HTMLElement {
  const existing = document.querySelector<HTMLElement>(`.${FLOATING_TOOLTIP_CLASS}`);
  if (existing) {
    existing.id = FLOATING_TOOLTIP_ID;
    return existing;
  }
  const tooltip = document.createElement("div");
  tooltip.id = FLOATING_TOOLTIP_ID;
  tooltip.className = FLOATING_TOOLTIP_CLASS;
  tooltip.setAttribute("role", "tooltip");
  tooltip.setAttribute("aria-hidden", "true");
  document.body.append(tooltip);
  return tooltip;
}

function showFloatingTooltip(element: HTMLElement, text: string) {
  const tooltip = getFloatingTooltip();
  tooltip.removeAttribute("aria-hidden");
  if (activeFloatingTooltipOwner && activeFloatingTooltipOwner !== element) {
    restoreFloatingTooltipDescription(activeFloatingTooltipOwner);
  }
  const duplicatesGeneratedAccessibleName =
    element.getAttribute(GENERATED_ARIA_LABEL_ATTR) === "true" &&
    element.getAttribute("aria-label")?.trim() === text.trim();
  if (duplicatesGeneratedAccessibleName) {
    restoreFloatingTooltipDescription(element);
  } else {
    ensureFloatingTooltipDescription(element, tooltip);
  }
  activeFloatingTooltipOwner = element;
  const rect = element.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const gutter = 8;
  const gap = 6;
  const maxTooltipWidth = Math.min(260, viewportWidth * 0.6);
  const midpoint = rect.left + rect.width / 2;
  const left = Math.min(
    Math.max(gutter + maxTooltipWidth / 2, midpoint),
    viewportWidth - gutter - maxTooltipWidth / 2,
  );
  tooltip.textContent = text;
  const tooltipHeight = tooltip.getBoundingClientRect().height;
  const belowTop = rect.bottom + gap;
  const aboveTop = rect.top - gap - tooltipHeight;
  const fitsBelow = belowTop + tooltipHeight <= viewportHeight - gutter;
  const preferredTop = fitsBelow ? belowTop : aboveTop;
  const maxTop = Math.max(gutter, viewportHeight - gutter - tooltipHeight);
  const top = Math.min(Math.max(gutter, preferredTop), maxTop);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
  tooltip.dataset.open = "true";
}

function hideFloatingTooltip() {
  const tooltip = document.querySelector<HTMLElement>(`.${FLOATING_TOOLTIP_CLASS}`);
  if (!tooltip) {
    return;
  }
  tooltip.dataset.open = "false";
  tooltip.setAttribute("aria-hidden", "true");
}

// Restore source titles before Lit renders so unchanged values remain visible to
// the post-render reconciliation and intentionally cleared titles stay cleared.
export function prepareActiveFloatingTooltipsForRender(root: ParentNode): void {
  for (const element of root.querySelectorAll<HTMLElement>(`[${ACTIVE_FLOATING_TOOLTIP_ATTR}]`)) {
    renderPreparedFloatingTooltips.add(element);
    restorePromotedTooltipTitle(element);
  }
}

function reconcilePreparedFloatingTooltips(root: ParentNode) {
  for (const element of root.querySelectorAll<HTMLElement>(`[${ACTIVE_FLOATING_TOOLTIP_ATTR}]`)) {
    if (!renderPreparedFloatingTooltips.delete(element)) {
      continue;
    }
    const title = element.getAttribute("title");
    if (title) {
      element.setAttribute(PROMOTED_TITLE_ATTR, title);
      ensurePromotedTooltipAccessibleName(element, title);
      if (
        !element.hasAttribute("data-tooltip") ||
        element.getAttribute(GENERATED_TOOLTIP_ATTR) === "true"
      ) {
        element.setAttribute("data-tooltip", title);
        element.setAttribute(GENERATED_TOOLTIP_ATTR, "true");
      }
      element.setAttribute("title", "");
      continue;
    }

    element.removeAttribute("title");
    element.removeAttribute(PROMOTED_TITLE_ATTR);
    restorePromotedTooltipAccessibleName(element);
    clearGeneratedTooltipMetadata(element);
    if (getTooltipText(element)) {
      continue;
    }
    element.removeAttribute(ACTIVE_FLOATING_TOOLTIP_ATTR);
    activeFloatingTooltipTriggers.delete(element);
    restoreFloatingTooltipDescription(element);
    if (activeFloatingTooltipOwner === element) {
      activeFloatingTooltipOwner = null;
    }
  }
}

export function clearActiveFloatingTooltips(root: ParentNode = document): void {
  for (const element of root.querySelectorAll<HTMLElement>(
    `[${ACTIVE_FLOATING_TOOLTIP_ATTR}], [${PROMOTED_TITLE_ATTR}]`,
  )) {
    restorePromotedTooltipTitle(element);
    element.removeAttribute(ACTIVE_FLOATING_TOOLTIP_ATTR);
    activeFloatingTooltipTriggers.delete(element);
    renderPreparedFloatingTooltips.delete(element);
    clearGeneratedTooltipMetadata(element);
    restorePromotedTooltipAccessibleName(element);
    restoreFloatingTooltipDescription(element);
  }
  if (activeFloatingTooltipOwner) {
    restoreFloatingTooltipDescription(activeFloatingTooltipOwner);
  }
  activeFloatingTooltipOwner = null;
  stopFloatingTooltipViewportTracking();
  hideFloatingTooltip();
}

export function promoteNativeTitleTooltip(
  target: EventTarget | null,
  root: ParentNode,
  trigger: FloatingTooltipTrigger,
): HTMLElement | null {
  const element = resolveTitleTooltipTarget(target, root);
  const tooltipText = element ? getTooltipText(element) : "";
  if (!element || !tooltipText) {
    return null;
  }
  const title = element.getAttribute("title");
  if (title) {
    element.setAttribute(PROMOTED_TITLE_ATTR, title);
  }
  ensurePromotedTooltipAccessibleName(element, title);
  if (
    !element.hasAttribute("data-tooltip") ||
    element.getAttribute(GENERATED_TOOLTIP_ATTR) === "true"
  ) {
    element.setAttribute("data-tooltip", tooltipText);
    element.setAttribute(GENERATED_TOOLTIP_ATTR, "true");
  }
  element.setAttribute("title", "");
  const triggers = activeFloatingTooltipTriggers.get(element) ?? new Set<FloatingTooltipTrigger>();
  triggers.add(trigger);
  activeFloatingTooltipTriggers.set(element, triggers);
  element.setAttribute(ACTIVE_FLOATING_TOOLTIP_ATTR, "true");
  startFloatingTooltipViewportTracking(root);
  showFloatingTooltip(element, tooltipText);
  return element;
}

export function refreshActiveFloatingTooltip(root: ParentNode): HTMLElement | null {
  reconcilePreparedFloatingTooltips(root);
  const owner = activeFloatingTooltipOwner;
  const element =
    owner && tooltipRootContains(root, owner) && owner.hasAttribute(ACTIVE_FLOATING_TOOLTIP_ATTR)
      ? owner
      : root.querySelector<HTMLElement>(`[${ACTIVE_FLOATING_TOOLTIP_ATTR}]`);
  if (!element) {
    if (activeFloatingTooltipOwner) {
      restoreFloatingTooltipDescription(activeFloatingTooltipOwner);
    }
    activeFloatingTooltipOwner = null;
    stopFloatingTooltipViewportTracking();
    hideFloatingTooltip();
    return null;
  }
  startFloatingTooltipViewportTracking(root);
  const tooltipText = getTooltipText(element);
  if (!tooltipText) {
    restorePromotedTooltipTitle(element);
    element.removeAttribute(ACTIVE_FLOATING_TOOLTIP_ATTR);
    activeFloatingTooltipTriggers.delete(element);
    renderPreparedFloatingTooltips.delete(element);
    clearGeneratedTooltipMetadata(element);
    restorePromotedTooltipAccessibleName(element);
    restoreFloatingTooltipDescription(element);
    activeFloatingTooltipOwner = null;
    return refreshActiveFloatingTooltip(root);
  }
  const title = element.getAttribute("title");
  if (title) {
    element.setAttribute(PROMOTED_TITLE_ATTR, title);
  }
  ensurePromotedTooltipAccessibleName(element, title);
  if (
    !element.hasAttribute("data-tooltip") ||
    element.getAttribute(GENERATED_TOOLTIP_ATTR) === "true"
  ) {
    element.setAttribute("data-tooltip", tooltipText);
    element.setAttribute(GENERATED_TOOLTIP_ATTR, "true");
  }
  element.setAttribute("title", "");
  showFloatingTooltip(element, tooltipText);
  return element;
}

export function restoreNativeTitleTooltip(
  target: EventTarget | null,
  root: ParentNode,
  trigger: FloatingTooltipTrigger,
  relatedTarget?: EventTarget | null,
): HTMLElement | null {
  const element = resolvePromotedTooltipTarget(target, root);
  if (!element) {
    return null;
  }
  if (relatedTarget instanceof Node && element.contains(relatedTarget)) {
    return null;
  }
  const triggers = activeFloatingTooltipTriggers.get(element);
  triggers?.delete(trigger);
  if (triggers?.size) {
    return null;
  }
  activeFloatingTooltipTriggers.delete(element);
  renderPreparedFloatingTooltips.delete(element);
  const wasOwner = activeFloatingTooltipOwner === element;
  restorePromotedTooltipTitle(element);
  element.removeAttribute(ACTIVE_FLOATING_TOOLTIP_ATTR);
  clearGeneratedTooltipMetadata(element);
  restorePromotedTooltipAccessibleName(element);
  restoreFloatingTooltipDescription(element);
  if (wasOwner) {
    activeFloatingTooltipOwner = null;
    refreshActiveFloatingTooltip(root);
  }
  return element;
}
