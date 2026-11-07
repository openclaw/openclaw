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

const RADIO_KEY_STEPS: Partial<Record<string, number>> = {
  ArrowDown: 1,
  ArrowRight: 1,
  ArrowUp: -1,
  ArrowLeft: -1,
};

/**
 * Arrow, Home and End movement for a `role="radiogroup"` of custom radios.
 * Returns the radio to focus and check, or undefined when the key is not a
 * group movement or the focused element is not one of `radios`. Callers pass
 * only the radios a user can reach (enabled, visible) and own the selection.
 */
export function nextRadio<T extends HTMLElement>(
  event: KeyboardEvent,
  radios: readonly T[],
): T | undefined {
  const current = radios.findIndex((radio) => radio === event.target);
  if (current < 0 || radios.length === 0) {
    return undefined;
  }
  if (event.key === "Home") {
    return radios[0];
  }
  if (event.key === "End") {
    return radios[radios.length - 1];
  }
  let step = RADIO_KEY_STEPS[event.key];
  if (step === undefined) {
    return undefined;
  }
  // Left and right follow reading direction; up and down never flip.
  if (
    (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
    getComputedStyle(radios[current]!).direction === "rtl"
  ) {
    step = -step;
  }
  return radios[(current + step + radios.length) % radios.length];
}
