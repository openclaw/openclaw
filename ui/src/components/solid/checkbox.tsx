import type { JSX } from "@solidjs/web";
import { omit } from "solid-js";

export type CheckboxProps = Omit<
  JSX.InputHTMLAttributes<HTMLInputElement>,
  "type" | "children" | "indeterminate"
> & {
  /** Mixed state, e.g. a select-all box over a partial selection. */
  indeterminate?: boolean;
};

/**
 * The console's one checkbox: a native input, so form, keyboard and label
 * behaviour stay the browser's. Associate it with text by wrapping it in a
 * `<label>` or passing `aria-label`.
 */
export function Checkbox(props: CheckboxProps) {
  const attributes = omit(props, "class", "indeterminate");
  return (
    <input
      {...attributes}
      type="checkbox"
      class={["oc-checkbox", props.class]}
      prop:indeterminate={props.indeterminate === true}
    />
  );
}
