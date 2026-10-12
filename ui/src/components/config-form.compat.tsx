import type { JSX } from "@solidjs/web";
import { LitContent } from "../lit/solid-bridge.ts";
import { ConfigMapField } from "./config-form.node.collection-map.tsx";
import type { LegacyNodeRenderer } from "./config-form.node.shared.ts";
import { renderNode } from "./config-form.node.tsx";

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
