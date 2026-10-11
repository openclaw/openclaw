// Shared body wrapper for settings and settings-adjacent pages. Settings
// section navigation lives in the takeover sidebar (settings-sidebar.ts).
import { html } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { shellLayoutTraits } from "../app/shell-layout-traits.ts";
import "../styles/settings.css";

export function renderSettingsWorkspace(
  body: unknown,
  options: {
    fillHeight?: boolean;
    id?: string;
  } = {},
) {
  const className = options.fillHeight
    ? "settings-workspace settings-workspace--fill-height"
    : "settings-workspace";
  return html`
    <section
      class=${className}
      ${shellLayoutTraits({ settingsWorkspace: true })}
      id=${ifDefined(options.id)}
    >
      <div class="settings-workspace__body">${body}</div>
    </section>
  `;
}
