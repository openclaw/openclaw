/** Horizontal strips: stops short of the region's scroll-padding, which keeps edge fades clear. */
export function revealInlineInScrollRegion(region: HTMLElement, option: HTMLElement): void {
  const bounds = region.getBoundingClientRect();
  const item = option.getBoundingClientRect();
  const style = getComputedStyle(region);
  const start = bounds.left + (Number.parseFloat(style.scrollPaddingLeft) || 0);
  const end = bounds.right - (Number.parseFloat(style.scrollPaddingRight) || 0);
  if (item.left < start) {
    region.scrollLeft -= Math.ceil(start - item.left);
  } else if (item.right > end) {
    region.scrollLeft += Math.ceil(item.right - end);
  }
}

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
