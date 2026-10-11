import "./config-form.bridge.tsx";
import { html, type nothing, type TemplateResult } from "lit";
import type { ConfigFormProps, ConfigTierGroupsProps } from "./config-form.render.tsx";

export type LegacyConfigFormProps = Omit<ConfigFormProps, "sectionActions" | "sectionPrelude"> & {
  sectionActions?: TemplateResult;
  sectionPrelude?: TemplateResult;
};
export type LegacyConfigTierGroupsProps = Omit<
  ConfigTierGroupsProps,
  "commonPrelude" | "renderTier"
> & {
  commonPrelude?: TemplateResult;
  renderTier: (node: ConfigTierGroupsProps["schema"]) => TemplateResult | typeof nothing;
};

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
