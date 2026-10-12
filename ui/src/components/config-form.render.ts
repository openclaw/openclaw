import "./config-form.bridge.tsx";
import { html } from "lit";
import type { LegacyConfigFormProps, LegacyConfigTierGroupsProps } from "./config-form.shared.ts";

export function renderConfigForm(props: LegacyConfigFormProps) {
  return html`<openclaw-config-form
    style="display:contents"
    .props=${props}
  ></openclaw-config-form>`;
}
export function renderConfigTierGroups(props: LegacyConfigTierGroupsProps) {
  return html`<openclaw-config-tier-groups
    style="display:contents"
    .props=${props}
  ></openclaw-config-tier-groups>`;
}
