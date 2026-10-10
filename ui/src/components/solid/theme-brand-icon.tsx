import type { JSX } from "@solidjs/web";
import { Show, createMemo } from "solid-js";
import type { ThemeBranding } from "../../../../packages/gateway-protocol/src/theme.ts";
import { currentThemeBranding } from "../../app/theme-branding.ts";
import { Icon } from "./icon.tsx";
import "../../styles/theme-brand-icon.css";

function ThemeArtwork(props: { url: string }) {
  const source = createMemo<string | null>(
    async () => {
      const url = props.url;
      try {
        const { fetchPluginThemeArtworkBlobUrl } =
          await import("../../pages/plugins/icon-loader.ts");
        return await fetchPluginThemeArtworkBlobUrl({ url });
      } catch {
        return null;
      }
    },
    { loadingValue: null },
  );
  return (
    <Show when={source()} keyed fallback={<Icon name="mark" />}>
      {(url) => <img class="brand-icon" alt="" src={url} />}
    </Show>
  );
}

export function ThemeBrandIcon(props: { branding?: ThemeBranding }): JSX.Element {
  const artworkUrl = createMemo(() => {
    const branding = props.branding ?? currentThemeBranding();
    return branding.artwork?.icons?.[branding.brandIcon]?.url;
  });
  return (
    <openclaw-theme-brand-icon aria-hidden="true">
      <Show when={artworkUrl()} keyed fallback={<Icon name="mark" />}>
        {(url) => <ThemeArtwork url={url} />}
      </Show>
    </openclaw-theme-brand-icon>
  );
}

export function renderThemeBrandIcon(
  claw: JSX.Element = <Icon name="lobster" />,
  branding: ThemeBranding = currentThemeBranding(),
  neutral: JSX.Element = <Icon name="mark" />,
): JSX.Element {
  if (branding.brandIcon === "claw") {
    return claw;
  }
  if (branding.brandIcon === "mark") {
    return neutral;
  }
  return <ThemeBrandIcon branding={branding} />;
}
