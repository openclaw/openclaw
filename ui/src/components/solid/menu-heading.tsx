import type { JSX } from "@solidjs/web";

/**
 * The one section label for menus and popovers: a small uppercase label in a
 * 28px band, with an optional trailing slot on the same line.
 *
 * Trailing content takes one of two shared classes:
 * - `oc-menu-heading__action` for a quiet text button or link ("Reset", "Learn more");
 * - `oc-menu-heading__value` for the section's current value ("High"), never interactive.
 */
export function MenuHeading(props: {
  label: JSX.Element;
  /** Labels a section through `aria-labelledby`. */
  id?: string;
  /** `h3` when the label names a landmark section; plain text otherwise. */
  as?: "h3";
  trailing?: JSX.Element;
  class?: JSX.ClassValue;
}) {
  return (
    <div class={["oc-menu-heading", props.class]}>
      {props.as === "h3" ? (
        <h3 id={props.id} class="oc-menu-heading__label">
          {props.label}
        </h3>
      ) : (
        <span id={props.id} class="oc-menu-heading__label">
          {props.label}
        </span>
      )}
      {props.trailing}
    </div>
  );
}
