import type { ControlUiToggleRowProps } from "../../../src/plugin-sdk/control-ui-components.js";
import { SettingsToggleRow } from "../components/solid/settings-ui.tsx";

export default function ToggleRow(props: ControlUiToggleRowProps) {
  return (
    <SettingsToggleRow
      {...props}
      description={<span style={{ "white-space": "pre-line" }}>{props.description}</span>}
    />
  );
}
