import { createMemo, For } from "solid-js";
import type { ControlUiAccessoryProps } from "../../../src/plugin-sdk/control-ui.js";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { PluginContribution } from "./control-ui-surfaces.solid.tsx";

type AccessoryProps = {
  [P in keyof ControlUiAccessoryProps]: { placement: P; value: ControlUiAccessoryProps[P] };
}[keyof ControlUiAccessoryProps];

/** Additive views retain the host’s draft/layout owners and use the plugin’s activation lifetime. */
export function PluginAccessories(props: AccessoryProps) {
  const context = useOptionalApplication();
  const runtime = context?.plugins && projectOwner(context.plugins, (owner) => owner);
  const entries = createMemo(
    () =>
      runtime
        ?.read()
        .registrations("accessories")
        .filter((entry) => entry.value.placement === props.placement) ?? [],
  );
  return (
    <For each={entries()} keyed={(entry) => entry.signal}>
      {(entry) => (
        <PluginContribution kind="accessories" contributionKey={entry().key} props={props.value} />
      )}
    </For>
  );
}
