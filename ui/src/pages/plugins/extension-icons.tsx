import { dynamic, type JSX } from "@solidjs/web";
import type { PluginUiCapability } from "../../../../packages/gateway-protocol/src/plugin-ui-capabilities.ts";
import { StrokeIcon } from "../../components/solid/stroke-icon.tsx";

function Frame() {
  return <rect x="2" y="3" width="20" height="18" rx="2" />;
}

// Keep contribution artwork with the lazy plugin page, not the startup icon catalog.
const extensionShapes = {
  page: () => (
    <>
      <rect x="4" y="2" width="16" height="20" rx="2" />
      <path d="M4 7h16M8 11h8M8 15h5" />
    </>
  ),
  navigation: () => (
    <>
      <Frame />
      <path d="M9 3v18M5 8h1M5 12h1M5 16h1M13 8h5" />
    </>
  ),
  panel: () => (
    <>
      <Frame />
      <path d="M14 3v18M17 8h2M17 12h2M5 8h5" />
    </>
  ),
  action: () => (
    <>
      <rect x="2" y="3" width="19" height="12" rx="3" />
      <path d="M6 8h4M13 10l8 7-4 .5-1.5 4-2.5-11.5Z" fill="currentColor" stroke-width="1.5" />
    </>
  ),
  accessory: () => (
    <>
      <Frame />
      <path d="M2 9h20M5 13h8M5 17h5" />
      <rect x="13" y="5" width="6" height="2" rx="1" fill="currentColor" stroke-width="0" />
    </>
  ),
  widget: () => (
    <>
      <rect x="3" y="3" width="7" height="11" rx="1.5" />
      <rect x="14" y="3" width="7" height="6" rx="1.5" />
      <rect x="14" y="13" width="7" height="8" rx="1.5" />
      <path d="M3 18h7M3 21h7" />
    </>
  ),
  inline: () => (
    <>
      <path d="M3 3h15M3 7h9M3 21h15" />
      <rect x="6" y="11" width="15" height="6" rx="1.5" />
      <path d="M10 14h.01M14 14h3" />
    </>
  ),
  replacement: () => (
    <>
      <rect x="2" y="2" width="9" height="8" rx="1.5" />
      <rect x="13" y="14" width="9" height="8" rx="1.5" />
      <path d="M15 5h6m-3-3 3 3-3 3M9 19H3m3-3-3 3 3 3" />
    </>
  ),
  "link-reader": () => (
    <>
      <Frame />
      <path d="M2 8h20M6 5.5h.01" />
      <path d="m9 13-1.5 1.5a2.1 2.1 0 0 0 3 3l1.5-1.5m0-3 1.5-1.5a2.1 2.1 0 0 1 3 3L15 16m-5-1 4-1" />
    </>
  ),
} satisfies Record<PluginUiCapability, () => JSX.Element>;

export function ExtensionIcon(props: { capability: PluginUiCapability }) {
  const Shape = dynamic(() => extensionShapes[props.capability]);
  return (
    <StrokeIcon aria-hidden="true">
      <Shape />
    </StrokeIcon>
  );
}
