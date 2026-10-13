import { html, nothing } from "lit";

export { nothing };

// The unported structured-draft owner consumes a Lit fragment for its child renderer.
export function renderPluginSettingsGroups(props: object) {
  return html`<openclaw-plugin-settings-groups .props=${props}></openclaw-plugin-settings-groups>`;
}
