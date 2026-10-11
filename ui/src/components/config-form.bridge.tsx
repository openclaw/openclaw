import { Show } from "solid-js";
import { defineSolidBridge } from "../lit/solid-bridge.ts";
import {
  ConfigFormCollectionDraftContent,
  type ConfigFormCollectionDraftProperties,
} from "./config-form-collection-draft.tsx";
import type { ConfigFormStructuredDraftProps } from "./config-form-structured-draft.ts";
import {
  LegacyConfigForm,
  LegacyConfigTierGroups,
  LegacyConfigMap,
  LegacyConfigStructuredDraft,
} from "./config-form.compat.tsx";
import type { ConfigNodeRenderParams } from "./config-form.node.shared.ts";
import type { LegacyNodeRenderer } from "./config-form.node.ts";
import { ConfigNode } from "./config-form.node.tsx";
import type { LegacyConfigFormProps, LegacyConfigTierGroupsProps } from "./config-form.render.ts";

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

export const ConfigStructuredDraftHost = defineSolidBridge<{
  props?: ConfigFormStructuredDraftProps;
}>(
  "openclaw-config-form-structured-draft",
  (props) => <LegacyConfigStructuredDraft props={props.props} />,
  { properties: { props: { default: undefined, attribute: false } } },
);

export const ConfigCollectionDraftHost = defineSolidBridge<
  ConfigFormCollectionDraftProperties,
  { openDraft(): void }
>(
  "openclaw-config-form-collection-draft",
  (props, host) => (
    <ConfigFormCollectionDraftContent props={props.props} draftOpen={props.draftOpen} host={host} />
  ),
  {
    properties: {
      props: { default: undefined, attribute: false },
      draftOpen: { default: false, attribute: false },
    },
    methods: {
      openDraft: (host) => {
        if (!host.props?.disabled) {
          host.draftOpen = true;
        }
      },
    },
  },
);
