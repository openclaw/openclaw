import { createMemo } from "solid-js";
import { BUILTIN_THEMES } from "../../../../packages/gateway-protocol/src/theme.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { PluginAccessories } from "../../plugins/control-ui-accessories.solid.tsx";
import type { ConfigProps } from "./view-types.ts";

/** The host preserves the shipped browser preference keys; plugins own their presentation. */
export function AmbientAppearanceSection(props: ConfigProps) {
  const activeTheme = createMemo(
    () =>
      BUILTIN_THEMES.find((theme) => theme.id === props.theme) ??
      props.themeCatalog?.themes.find((theme) => theme.id === props.theme),
  );
  return (
    <PluginAccessories
      placement="ambient-appearance"
      value={{
        visitsEnabled: props.lobsterPetVisits,
        soundsEnabled: props.lobsterPetSounds,
        themeName:
          activeTheme()?.source === "builtin"
            ? t(`configView.themes.${activeTheme()?.id}.label`)
            : (activeTheme()?.name ?? props.theme),
        onChange: (change) =>
          props.onAppearanceChange({
            ...(change.visitsEnabled !== undefined
              ? { lobsterPetVisits: change.visitsEnabled }
              : {}),
            ...(change.soundsEnabled !== undefined
              ? { lobsterPetSounds: change.soundsEnabled }
              : {}),
          }),
      }}
    />
  );
}
