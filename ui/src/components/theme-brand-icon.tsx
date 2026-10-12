import { Show } from "solid-js";
import type { ThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { currentThemeBranding } from "../app/theme-branding.ts";
import { defineSolidBridge } from "../lit/solid-bridge.ts";
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
