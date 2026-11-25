import type { JSX } from "@solidjs/web";
import "./radio.css";

/** The single-choice mark for rows that own `role="radio"`; they pass their state in. */
export function RadioMark(props: { checked?: boolean; disabled?: boolean; class?: string }) {
  return (
    <span
      class={["oc-radio", props.class]}
      data-checked={props.checked ? "" : undefined}
      data-disabled={props.disabled ? "" : undefined}
      aria-hidden="true"
    />
  );
}

/**
 * A native radio wrapped in its label, so clicking the text checks it, the
 * accessible name comes from the children, and same-`name` inputs keep the
 * browser's arrow-key group behavior. The input itself wears the mark.
 */
export function Radio(props: {
  name: string;
  value?: string;
  checked: boolean;
  disabled?: boolean;
  class?: JSX.HTMLAttributes<HTMLLabelElement>["class"];
  onChange: () => void;
  children: JSX.Element;
}) {
  return (
    <label class={["oc-radio-field", props.class]}>
      <input
        class="oc-radio"
        type="radio"
        name={props.name}
        value={props.value}
        checked={props.checked}
        disabled={props.disabled}
        onChange={() => props.onChange()}
      />
      {props.children}
    </label>
  );
}
