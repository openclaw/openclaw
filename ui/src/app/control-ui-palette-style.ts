/** Geometry and the derived chrome color do not invalidate palette samples. */
export function controlUiPaletteStyle(root: HTMLElement): string {
  return JSON.stringify(
    [...root.style]
      .filter(
        (property) =>
          property !== "--shell-viewport-height" &&
          property !== "--shell-safe-area-bottom" &&
          property !== "background-color" &&
          property !== "--link" &&
          property !== "--link-on-tint" &&
          !/^--oc-(assistant|terminal|browser|link-reader|desktop)-reserve-(bottom|right)$/u.test(
            property,
          ),
      )
      .map((property) => [
        property,
        root.style.getPropertyValue(property),
        root.style.getPropertyPriority(property),
      ]),
  );
}
