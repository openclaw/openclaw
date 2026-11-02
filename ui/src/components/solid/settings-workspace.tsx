import type { JSX } from "@solidjs/web";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import "../../styles/settings.css";

export function SettingsWorkspace(props: {
  children?: JSX.Element;
  fillHeight?: boolean;
  id?: string;
}) {
  return (
    <ShellLayoutBoundary traits={{ settingsWorkspace: true }}>
      <section
        class={["settings-workspace", { "settings-workspace--fill-height": props.fillHeight }]}
        id={props.id}
      >
        <div class="settings-workspace__body">{props.children}</div>
      </section>
    </ShellLayoutBoundary>
  );
}
