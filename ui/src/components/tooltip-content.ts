export function normalizeTooltipText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

export function isTooltipTriggerElement(element: unknown): element is HTMLElement | SVGElement {
  return (
    typeof element === "object" &&
    element !== null &&
    "namespaceURI" in element &&
    (element.namespaceURI === "http://www.w3.org/1999/xhtml" ||
      element.namespaceURI === "http://www.w3.org/2000/svg")
  );
}

function isElementNode(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE;
}

function collectTooltipText(
  root: Element,
  checkOpacity: boolean,
  overflowTargets?: Element[],
): string {
  function collect(element: Element, collectText: boolean): string {
    if (overflowTargets && (element === root || isTooltipTriggerElement(element))) {
      overflowTargets.push(element);
    }
    const style = collectText
      ? element.ownerDocument.defaultView?.getComputedStyle(element)
      : undefined;
    const hidesText =
      !collectText ||
      element.hasAttribute("hidden") ||
      (!checkOpacity && element.getAttribute("aria-hidden") === "true") ||
      (checkOpacity && element !== root && style?.opacity === "0") ||
      style?.display === "none" ||
      style?.contentVisibility === "hidden";
    if (hidesText && !overflowTargets) {
      return "";
    }
    // Hidden descendants still participate in overflow, but not in label text.
    // Opacity on the trigger or an entering ancestor does not hide its own label.
    const rendersOwnText =
      !hidesText &&
      style?.visibility !== "hidden" &&
      style?.visibility !== "collapse" &&
      (style?.display === "contents" ||
        typeof element.checkVisibility !== "function" ||
        element.checkVisibility({ checkVisibilityCSS: true }));
    return [...element.childNodes]
      .map((node) => {
        if (isElementNode(node)) {
          return collect(node, !hidesText);
        }
        return node.nodeType === Node.TEXT_NODE && rendersOwnText ? (node.textContent ?? "") : "";
      })
      .join(" ");
  }
  return collect(root, true);
}

export function collectTooltipNameText(element: Element): string {
  // Transparent entry animations do not hide text from accessibility APIs.
  // Replacing that name with a title would persist after the animation ends.
  return collectTooltipText(element, false);
}

function hasTooltipOverflow(element: Element) {
  return (
    element.matches("[data-tooltip-overflow]") ||
    element.scrollWidth > element.clientWidth ||
    element.scrollHeight > element.clientHeight
  );
}

export function isTooltipTextRedundant(content: string, trigger: Element) {
  const tooltipText = normalizeTooltipText(content);
  if (!tooltipText) {
    return false;
  }
  if (!trigger.textContent?.trim()) {
    return false;
  }
  const overflowTargets: Element[] = [];
  const triggerText = normalizeTooltipText(collectTooltipText(trigger, true, overflowTargets));
  // Read geometry only when text repeats; the text walk already collected its targets.
  return triggerText.includes(tooltipText) && !overflowTargets.some(hasTooltipOverflow);
}
