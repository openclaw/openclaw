import type { JSX } from "@solidjs/web";
import { LitContent } from "../lit/solid-bridge.ts";
import type { ConfigFormStructuredDraftProps } from "./config-form-structured-draft.ts";
import { ConfigFormStructuredDraftContent } from "./config-form-structured-draft.tsx";
import { ConfigMapField } from "./config-form.node.collection-map.tsx";
import type { LegacyNodeRenderer } from "./config-form.node.ts";
import { renderNode } from "./config-form.node.tsx";
import type { LegacyConfigFormProps, LegacyConfigTierGroupsProps } from "./config-form.render.ts";
import { ConfigForm, ConfigTierGroups } from "./config-form.render.tsx";

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
export function LegacyConfigStructuredDraft(props: {
  props?: ConfigFormStructuredDraftProps;
}): JSX.Element {
  return (
    <ConfigFormStructuredDraftContent
      props={
        props.props && {
          ...props.props,
          renderNode:
            props.props.renderSolidNode ??
            ((params) => <LitContent render={() => props.props?.renderNode?.(params())} />),
        }
      }
    />
  );
}
