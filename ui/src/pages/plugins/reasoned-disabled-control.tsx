import type { JSX } from "@solidjs/web";
import "../../components/tooltip.ts";

/** Keep blocked controls focusable so their reason remains available. */
export function ReasonedDisabledControl(props: {
  reason: string | null | undefined;
  children: JSX.Element;
}) {
  return (
    <>
      {props.reason ? (
        <openclaw-tooltip open-on-click prop:content={props.reason}>
          {props.children}
        </openclaw-tooltip>
      ) : (
        props.children
      )}
    </>
  );
}
