import type { JSX } from "@solidjs/web";
import { Icon } from "./icon.tsx";

/** The quiet chevron row for on-demand detail; opens subrows beneath it. */
export function SettingsDisclosure(props: { label: JSX.Element; children?: JSX.Element }) {
  return (
    <details class="cfg-object settings-disclosure">
      <summary class="settings-row cfg-object__summary">
        <span class="settings-row__desc">{props.label}</span>
        <div class="settings-row__control">
          <span class="settings-row__chevron cfg-object__chevron">
            <Icon name="chevronRight" />
          </span>
        </div>
      </summary>
      <div class="settings-subrows">{props.children}</div>
    </details>
  );
}
