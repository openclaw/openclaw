import type { JSX } from "@solidjs/web";
import "../../components/ip-location.ts";
import type { LinkReaderHovercardProvider } from "../../components/link-reader-hovercard.ts";
import "../../components/viewer-facepile.ts";

type LegacyElement<
  Element extends HTMLElement,
  Property extends keyof Element,
> = JSX.HTMLAttributes<Element> & {
  [Key in Property as `prop:${Key & string}`]?: Element[Key];
};

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-viewer-avatar": LegacyElement<
        HTMLElementTagNameMap["openclaw-viewer-avatar"],
        "identity" | "user" | "markAsViewer"
      > & { variant?: HTMLElementTagNameMap["openclaw-viewer-avatar"]["variant"] };
      "openclaw-ip-location": LegacyElement<HTMLElementTagNameMap["openclaw-ip-location"], "ip">;
      "openclaw-link-reader-hovercard-provider": LegacyElement<
        LinkReaderHovercardProvider,
        "client" | "readers" | "agentId" | "previewSeeds"
      >;
    }
  }
}
