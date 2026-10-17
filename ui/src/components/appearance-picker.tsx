import { createSignal } from "solid-js";
import {
  normalizeSessionIconValue,
  SESSION_ICON_GLYPH_IDS,
  SESSION_ICON_SVG_DATA_URL_PREFIX,
} from "../../../packages/gateway-protocol/src/session-agent-status.js";
import type {
  ControlUiAppearanceGlyphProps,
  ControlUiAppearancePickerProps,
} from "../../../src/plugin-sdk/control-ui-components.js";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import { SessionIconGraphic } from "./session-icon-glyph-solid.tsx";
import {
  AppearancePicker as AppearanceGrid,
  type AppearancePickerFocus,
} from "./session-icon-picker-solid.tsx";
import "../styles/sidebar-menus.css";
import "../styles/appearance-picker.css";

type PickerProperties = { props: ControlUiAppearancePickerProps };
type GlyphProperties = { props: ControlUiAppearanceGlyphProps };
export type AppearancePicker = SolidBridgeElement<PickerProperties>;
export type AppearanceGlyph = SolidBridgeElement<GlyphProperties>;

export const AppearancePicker = defineSolidBridge<PickerProperties>(
  "openclaw-appearance-picker",
  (properties) => {
    const [mode, setMode] = createSignal<"grid" | "custom">("grid");
    const [customIcon, setCustomIcon] = createSignal("");
    let focus: AppearancePickerFocus | undefined;
    const select = (icon: string | null, color: string | null) => {
      if (!properties.props.disabled) {
        properties.props.onChange({ icon, color });
      }
    };
    const showGrid = () => {
      setMode("grid");
      setCustomIcon("");
      focus?.("grid");
    };
    return (
      <AppearanceGrid
        ref={(handle) => (focus = handle)}
        clearable={properties.props.clearable}
        mode={mode()}
        currentIcon={properties.props.icon}
        currentColor={properties.props.color}
        disabled={properties.props.disabled ?? false}
        colorDisabled={properties.props.disabled ?? false}
        customIconValue={customIcon()}
        onSelectColor={(_event, color) => select(properties.props.icon, color)}
        onSelect={(_event, icon) => select(icon, properties.props.color)}
        onReset={() => select(null, null)}
        onShowCustom={() => {
          setMode("custom");
          setCustomIcon("");
          focus?.("custom");
        }}
        onBack={showGrid}
        onInput={(event) => setCustomIcon(event.currentTarget.value)}
        onApply={() => {
          const icon = normalizeSessionIconValue(customIcon());
          if (icon && !properties.props.disabled) {
            select(icon, properties.props.color);
            showGrid();
          }
        }}
      />
    );
  },
  {
    properties: {
      props: { default: { icon: null, color: null, onChange: () => {} }, attribute: false },
    },
  },
);

export const AppearanceGlyph = defineSolidBridge<GlyphProperties>(
  "openclaw-appearance-glyph",
  (properties) => {
    const icon = () => properties.props.icon?.trim();
    return (
      <>
        {icon() ? (
          SESSION_ICON_GLYPH_IDS.some((glyph) => glyph === icon()) ||
          icon()!.startsWith(SESSION_ICON_SVG_DATA_URL_PREFIX) ? (
            <SessionIconGraphic icon={icon()!} />
          ) : (
            icon()
          )
        ) : (
          properties.props.fallback
        )}
      </>
    );
  },
  {
    properties: { props: { default: { icon: null, color: null, fallback: "" }, attribute: false } },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-appearance-picker": AppearancePicker;
    "openclaw-appearance-glyph": AppearanceGlyph;
  }
}
