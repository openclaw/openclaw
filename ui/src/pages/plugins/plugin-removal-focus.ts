/**
 * Confirmed removal retires the focused Uninstall control. Move focus that fell to the
 * document body onto the remaining view's heading; leave focus the user moved elsewhere.
 */
export function focusHeadingAfterRemoval(page: HTMLElement, trigger: Element | null): void {
  if (!trigger || trigger.isConnected || document.activeElement !== document.body) {
    return;
  }
  const heading =
    page.querySelector<HTMLElement>(".plugin-catalog-detail__heading h1") ??
    page.querySelector<HTMLElement>("h1.page-title");
  if (!heading) {
    return;
  }
  heading.tabIndex = -1;
  heading.focus();
}
