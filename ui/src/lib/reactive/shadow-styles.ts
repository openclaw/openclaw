import { createEffect } from "solid-js";
import { bindShadowStyles } from "../../components/solid/shadow-styles.ts";

export function createShadowStyles(
  getElement: () => HTMLElement,
  getStyles: () => readonly string[],
) {
  createEffect(getStyles, (styles) => {
    const binding = bindShadowStyles(getElement(), styles);
    return () => binding.dispose();
  });
}
