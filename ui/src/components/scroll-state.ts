/** Reveal an option without scrollIntoView also moving its popup's ancestors. */
export function revealInScrollRegion(region: HTMLElement, option: HTMLElement): void {
  const bounds = region.getBoundingClientRect();
  const row = option.getBoundingClientRect();
  // Opening popovers scale their geometry; scrollTop remains in unscaled CSS pixels.
  const scale = bounds.height / region.offsetHeight;
  if (row.top < bounds.top) {
    region.scrollTop -= Math.ceil((bounds.top - row.top) / scale);
  } else if (row.bottom > bounds.bottom) {
    region.scrollTop += Math.ceil((row.bottom - bounds.bottom) / scale);
  }
}
