import type { JSX } from "@solidjs/web";
import { LitContent } from "../lit/solid-bridge.ts";
import { ConfigMapField } from "./config-form.node.collection-map.tsx";
import type { LegacyNodeRenderer } from "./config-form.node.shared.ts";
import { renderNode } from "./config-form.node.tsx";
import { ConfigForm, ConfigTierGroups } from "./config-form.render.tsx";
import type { LegacyConfigFormProps, LegacyConfigTierGroupsProps } from "./config-form.shared.ts";

export function LegacyConfigForm(props: { props: LegacyConfigFormProps }): JSX.Element {
  return (
    <ConfigForm
      {...props.props}
      sectionActions={
        props.props.sectionActions && <LitContent render={() => props.props.sectionActions} />
      }
      sectionPrelude={
        props.props.sectionPrelude && <LitContent render={() => props.props.sectionPrelude} />
      }
    />
  );
}
export function LegacyConfigTierGroups(props: { props: LegacyConfigTierGroupsProps }): JSX.Element {
  return (
    <ConfigTierGroups
      {...props.props}
      commonPrelude={
        props.props.commonPrelude && <LitContent render={() => props.props.commonPrelude} />
      }
      renderTier={(node) => <LitContent render={() => props.props.renderTier(node())} />}
    />
  );
}
export function LegacyConfigMap(props: {
  params: Parameters<typeof ConfigMapField>[0]["params"];
  renderNode?: LegacyNodeRenderer;
}): JSX.Element {
  return (
    <ConfigMapField
      params={props.params}
      renderNode={(params) =>
        props.renderNode ? (
          <LitContent render={() => props.renderNode?.(params())} />
        ) : (
          renderNode(params)
        )
      }
    />
  );
}
