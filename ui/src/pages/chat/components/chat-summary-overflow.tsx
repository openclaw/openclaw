import { createEffect, onSettled } from "solid-js";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";

type Props = { text: string };
export type ChatSummaryOverflow = SolidBridgeElement<Props>;

/** Fade only measured overflow; the unabridged string remains accessible. */
export const ChatSummaryOverflow = defineSolidBridge<Props>(
  "openclaw-summary-overflow",
  (props, host) => {
    const measure = () =>
      host.toggleAttribute("data-overflow", host.scrollWidth > host.clientWidth + 1);
    createEffect(
      () => props.text,
      (text) => {
        host.title = text;
        measure();
      },
    );
    onSettled(() => {
      const observer =
        typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
      observer?.observe(host);
      host.ownerDocument.fonts?.addEventListener("loadingdone", measure);
      measure();
      return () => {
        observer?.disconnect();
        host.ownerDocument.fonts?.removeEventListener("loadingdone", measure);
      };
    });
    return <>{props.text}</>;
  },
  { properties: { text: { default: "" } } },
);
