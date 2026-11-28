import type { connect } from "@zag-js/menu";
import { normalizeProps } from "@zag-js/vanilla";

// Focus events use bubbling DOM names; all other listener names stay canonical.
const normalize = (props: object) => {
  const out: Record<string, unknown> = { ...props };
  for (const from of ["onFocus", "onBlur"] as const) {
    if (from in out) {
      out[from === "onFocus" ? "onFocusIn" : "onFocusOut"] = out[from];
      delete out[from];
    }
  }
  return out;
};
export const menuPropNormalizer: Parameters<typeof connect>[1] = {
  element: normalize,
  // Skip only Zag's trigger focus prevention on touch, not the parent item's pointer handler.
  button: (props) =>
    normalize({
      ...props,
      onPointerDown(event) {
        if (event.pointerType !== "touch") {
          props.onPointerDown?.(event);
        }
      },
    } satisfies typeof props),
  input: normalize,
  label: normalize,
  circle: normalize,
  img: normalize,
  output: normalize,
  path: normalize,
  select: normalize,
  svg: normalize,
  textarea: normalize,
  rect: normalize,
  style: normalizeProps.style,
};
