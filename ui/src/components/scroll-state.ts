/** Reveal an option without scrollIntoView also moving its popup's ancestors. */
export function revealInScrollRegion(region: HTMLElement, option: HTMLElement): void {
  const bounds = region.getBoundingClientRect();
  const row = option.getBoundingClientRect();
  if (row.top < bounds.top) {
    region.scrollTop -= bounds.top - row.top;
  } else if (row.bottom > bounds.bottom) {
    region.scrollTop += row.bottom - bounds.bottom;
  }
}
