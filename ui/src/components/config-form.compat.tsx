import type { JSX } from "@solidjs/web";
import { nothing, render, type TemplateResult } from "lit";
import { createEffect, onCleanup } from "solid-js";
import type { ConfigFormStructuredDraftProps } from "./config-form-structured-draft.ts";
import { ConfigFormStructuredDraftContent } from "./config-form-structured-draft.tsx";
import { ConfigMapField } from "./config-form.node.collection-map.tsx";
import { ConfigArray, ConfigObject } from "./config-form.node.collection.tsx";
import { JsonTextarea } from "./config-form.node.json.tsx";
import { NumberInput, SelectInput, TextInput } from "./config-form.node.scalar.tsx";
import type { ConfigNodeRenderParams, ConfigNodeRenderer } from "./config-form.node.shared.ts";
import { ConfigNode, renderNode } from "./config-form.node.tsx";
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
export function LegacyConfigNode(props: { params: ConfigNodeRenderParams }): JSX.Element {
  return <ConfigNode params={props.params} />;
}
type LegacyCollectionProps = { params: ConfigNodeRenderParams; renderNode?: LegacyNodeRenderer };
function collectionRenderer(props: { renderNode?: LegacyNodeRenderer }): ConfigNodeRenderer {
  return (params) =>
    props.renderNode ? (
      <ConfigFormLitContent content={props.renderNode(params())} />
    ) : (
      renderNode(params)
    );
}
export function LegacyConfigArray(props: LegacyCollectionProps): JSX.Element {
  return <ConfigArray params={props.params} renderNode={collectionRenderer(props)} />;
}
export function LegacyConfigObject(props: LegacyCollectionProps): JSX.Element {
  return <ConfigObject params={props.params} renderNode={collectionRenderer(props)} />;
}
export function LegacyConfigMap(props: {
  params: Parameters<typeof ConfigMapField>[0]["params"];
  renderNode?: LegacyNodeRenderer;
}): JSX.Element {
  return <ConfigMapField params={props.params} renderNode={collectionRenderer(props)} />;
}
export function LegacyConfigText(props: {
  params: Parameters<typeof TextInput>[0]["params"];
}): JSX.Element {
  return <TextInput params={props.params} />;
}
export function LegacyConfigNumber(props: { params: ConfigNodeRenderParams }): JSX.Element {
  return <NumberInput params={props.params} />;
}
export function LegacyConfigSelect(props: {
  params: Parameters<typeof SelectInput>[0]["params"];
}): JSX.Element {
  return <SelectInput params={props.params} />;
}
export function LegacyConfigJson(props: { params: ConfigNodeRenderParams }): JSX.Element {
  return <JsonTextarea params={props.params} />;
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
