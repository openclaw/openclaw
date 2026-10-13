import { Show } from "solid-js";
import { defineSolidBridge } from "../lit/solid-bridge.ts";
import "./config-form-collection-draft.tsx";
import "./config-form-structured-draft.tsx";
import { LegacyConfigMap } from "./config-form.compat.tsx";
import type { ConfigNodeRenderParams, LegacyNodeRenderer } from "./config-form.node.shared.ts";
import { ConfigNode } from "./config-form.node.tsx";

defineSolidBridge<{ params?: ConfigNodeRenderParams }>(
  "openclaw-config-node",
  (props) => <Show when={props.params}>{(params) => <ConfigNode params={params()} />}</Show>,
  { properties: { params: { default: undefined, attribute: false } } },
);

defineSolidBridge<{
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
