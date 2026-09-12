export function hoverDetails(row: Element | null | undefined) {
  return [
    ...(row
      ?.closest("openclaw-tooltip")
      ?.querySelectorAll('[slot="content"] > div, [slot="content"] > span') ?? []),
  ]
    .map((detail) => detail.textContent?.trim())
    .join(" · ");
}

export function capacityCaption(row: Element | null | undefined) {
  return row
    ?.closest("openclaw-tooltip")
    ?.querySelector(".new-session-page__capacity-caption")
    ?.textContent?.trim();
}
