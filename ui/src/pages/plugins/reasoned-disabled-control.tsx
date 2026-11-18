import type { JSX } from "@solidjs/web";
import "../../components/tooltip.ts";

/** Keep blocked controls focusable so their reason remains available. */
export function ReasonedDisabledControl(props: {
  reason: string | null | undefined;
  descriptionTarget?: () => Element | null;
  children: JSX.Element;
}) {
  return (
    <>
      {props.reason ? (
        <openclaw-tooltip
          open-on-click
          prop:content={props.reason}
          prop:descriptionTarget={props.descriptionTarget}
        >
          {props.children}
        </openclaw-tooltip>
      ) : (
        props.children
      )}
    </>
  );
}
