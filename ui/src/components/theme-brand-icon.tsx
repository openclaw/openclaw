import type { JSX as SolidJSX } from "@solidjs/web";
import { Show } from "solid-js";
import type { ThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { currentThemeBranding, subscribeThemeBranding } from "../app/theme-branding.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import { PluginThemeArtwork } from "./plugin-theme-artwork.tsx";
import { Icon } from "./solid/icon.tsx";
import "./theme-brand-icon.css";

export const ThemeBrandIcon = defineSolidBridge<{ branding?: ThemeBranding }>(
  "openclaw-theme-brand-icon",
  (props) => {
    const artwork = () => {
      const branding = props.branding ?? currentThemeBranding();
      return branding.artwork?.icons?.[branding.brandIcon];
    };
    return (
      <Show when={artwork()} fallback={<Icon name="mark" />}>
        {(icon) => (
          <PluginThemeArtwork url={icon().url} class="brand-icon" fallback={<Icon name="mark" />} />
        )}
      </Show>
    );
  },
  { properties: { branding: { default: undefined, attribute: false } } },
);

export function ThemeBrandingIcon(props: { branding?: ThemeBranding; claw?: SolidJSX.Element }) {
  const publishedBranding = projectSource(null, {
    read: currentThemeBranding,
    subscribe: (_source, notify) => subscribeThemeBranding(notify),
    equality: Object.is,
  });
  const branding = () => props.branding ?? publishedBranding.read();
  return (
    <Show when={branding().brandIcon !== "claw"} fallback={props.claw ?? <Icon name="lobster" />}>
      <Show when={branding().brandIcon !== "mark"} fallback={<Icon name="mark" />}>
        <ThemeBrandIcon branding={branding()} />
      </Show>
    </Show>
  );
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-theme-brand-icon": SolidBridgeElement<{ branding?: ThemeBranding }>;
  }
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-theme-brand-icon": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-theme-brand-icon"]
      > & {
        "prop:branding"?: ThemeBranding;
      };
    }
  }
}
