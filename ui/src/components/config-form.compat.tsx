import type { JSX } from "@solidjs/web";
import { nothing, render, type TemplateResult } from "lit";
import { createEffect, onCleanup } from "solid-js";
import type { ConfigFormStructuredDraftProps } from "./config-form-structured-draft.ts";
import { ConfigFormStructuredDraftContent } from "./config-form-structured-draft.tsx";
import { ConfigMapField } from "./config-form.node.collection-map.tsx";
import type { ConfigNodeRenderParams } from "./config-form.node.shared.ts";
import { renderNode } from "./config-form.node.tsx";
import {
  ConfigForm,
  ConfigTierGroups,
  type ConfigFormProps,
  type ConfigTierGroupsProps,
} from "./config-form.render.tsx";

export type LegacyNodeRenderer = (
  params: ConfigNodeRenderParams,
) => TemplateResult | typeof nothing;
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

/** Unported callers own this isolated slot; Solid owns its surrounding form. */
export function ConfigFormLitContent(props: { content: unknown }): JSX.Element {
  let host!: HTMLSpanElement;
  createEffect(
    () => props.content,
    (content) => {
      render(content, host);
    },
  );
  onCleanup(() => render(nothing, host));
  return (
    <span
      ref={(element) => {
        host = element;
      }}
      style={{ display: "contents" }}
    />
  );
}

export function LegacyConfigForm(props: { props: LegacyConfigFormProps }): JSX.Element {
  return (
    <ConfigForm
      {...props.props}
      sectionActions={
        props.props.sectionActions && <ConfigFormLitContent content={props.props.sectionActions} />
      }
      sectionPrelude={
        props.props.sectionPrelude && <ConfigFormLitContent content={props.props.sectionPrelude} />
      }
    />
  );
}
export function LegacyConfigTierGroups(props: { props: LegacyConfigTierGroupsProps }): JSX.Element {
  return (
    <ConfigTierGroups
      {...props.props}
      commonPrelude={
        props.props.commonPrelude && <ConfigFormLitContent content={props.props.commonPrelude} />
      }
      renderTier={(node) => <ConfigFormLitContent content={props.props.renderTier(node())} />}
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
          <ConfigFormLitContent content={props.renderNode(params())} />
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
            ((params) => <ConfigFormLitContent content={props.props?.renderNode?.(params())} />),
        }
      }
    />
  );
}
