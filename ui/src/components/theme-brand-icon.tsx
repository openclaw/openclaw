import type { JSX as SolidJSX } from "@solidjs/web";
import { omit, Show } from "solid-js";
import type { ThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { currentThemeBranding } from "../app/theme-branding.ts";
import { themeBrandingProjection } from "../lib/reactive/theme-branding.ts";
import { PluginThemeArtwork } from "./plugin-theme-artwork.tsx";
import { Icon } from "./solid/icon.tsx";
import "./theme-brand-icon.css";

export function ThemeBrandIcon(
  props: { branding?: ThemeBranding } & SolidJSX.HTMLAttributes<HTMLElement>,
) {
  const artwork = () => {
    const branding = props.branding ?? currentThemeBranding();
    return branding.artwork?.icons?.[branding.brandIcon];
  };
  return (
    <openclaw-theme-brand-icon {...omit(props, "branding", "children")}>
      <Show when={artwork()} fallback={<Icon name="mark" />}>
        {(icon) => (
          <PluginThemeArtwork url={icon().url} class="brand-icon" fallback={<Icon name="mark" />} />
        )}
      </Show>
    </openclaw-theme-brand-icon>
  );
}

export function ThemeBrandingIcon(props: { branding?: ThemeBranding; claw?: SolidJSX.Element }) {
  const publishedBranding = themeBrandingProjection;
  const branding = () => props.branding ?? publishedBranding.read();
  return (
    <Show when={branding().brandIcon !== "claw"} fallback={props.claw ?? <Icon name="lobster" />}>
      <Show when={branding().brandIcon !== "mark"} fallback={<Icon name="mark" />}>
        <ThemeBrandIcon branding={branding()} />
      </Show>
    </Show>
  );
}
