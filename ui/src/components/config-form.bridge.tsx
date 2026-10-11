import { Show } from "solid-js";
import { defineSolidBridge } from "../lit/solid-bridge.ts";
import "./config-form-collection-draft.tsx";
import "./config-form-structured-draft.tsx";
import {
  LegacyConfigForm,
  LegacyConfigTierGroups,
  LegacyConfigMap,
} from "./config-form.compat.tsx";
import type { ConfigNodeRenderParams, LegacyNodeRenderer } from "./config-form.node.shared.ts";
import { ConfigNode } from "./config-form.node.tsx";
import type { LegacyConfigFormProps, LegacyConfigTierGroupsProps } from "./config-form.shared.ts";

export const ConfigFormHost = defineSolidBridge<{ props?: LegacyConfigFormProps }>(
  "openclaw-config-form",
  (props) => <Show when={props.props}>{(model) => <LegacyConfigForm props={model()} />}</Show>,
  { properties: { props: { default: undefined, attribute: false } } },
);

export const ConfigTierGroupsHost = defineSolidBridge<{ props?: LegacyConfigTierGroupsProps }>(
  "openclaw-config-tier-groups",
  (props) => (
    <Show when={props.props}>{(model) => <LegacyConfigTierGroups props={model()} />}</Show>
  ),
  { properties: { props: { default: undefined, attribute: false } } },
);

export const ConfigNodeHost = defineSolidBridge<{ params?: ConfigNodeRenderParams }>(
  "openclaw-config-node",
  (props) => <Show when={props.params}>{(params) => <ConfigNode params={params()} />}</Show>,
  { properties: { params: { default: undefined, attribute: false } } },
);

export const ConfigMapHost = defineSolidBridge<{
  params?: Parameters<typeof LegacyConfigMap>[0]["params"];
  renderNode?: LegacyNodeRenderer;
}>(
  "openclaw-config-map",
  (props) => (
    <Show when={props.params}>
      {(params) => <LegacyConfigMap params={params()} renderNode={props.renderNode} />}
    </Show>
  ),
  {
    properties: {
      params: { default: undefined, attribute: false },
      renderNode: { default: undefined, attribute: false },
    },
  },
);
