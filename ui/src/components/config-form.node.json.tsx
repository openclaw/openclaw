import type { JSX } from "@solidjs/web";
import { createMemo } from "solid-js";
import { getLocale } from "../lib/reactive/i18n.ts";
import {
  getSensitiveRenderState,
  jsonValue,
  FieldRow,
  JsonTextareaControl,
  renderSchemaDefaultDescription,
  resolveConfigFieldPresentation,
  type ConfigNodeRenderParams,
} from "./config-form.node.shared.tsx";

export function JsonTextarea(props: { params: ConfigNodeRenderParams }): JSX.Element {
  const field = createMemo(() => {
    getLocale();
    return resolveConfigFieldPresentation(props.params);
  });
  const sensitiveState = createMemo(() => getSensitiveRenderState(props.params));
  return (
    <FieldRow
      label={field().label}
      help={field().help}
      helpId={field().helpId}
      showLabel={field().showLabel}
      defaultDescription={
        sensitiveState().isRedacted
          ? undefined
          : renderSchemaDefaultDescription(props.params.schema, props.params.value)
      }
      stacked
      control={
        <JsonTextareaControl
          schema={props.params.schema}
          path={props.params.path}
          ariaLabel={field().label}
          descriptionId={field().helpId}
          sourceValue={props.params.sourceIdentity ?? props.params.value}
          fallback={jsonValue(
            props.params.value !== undefined ? props.params.value : props.params.schema.default,
          )}
          rows={3}
          sensitiveState={sensitiveState()}
          disabled={props.params.disabled}
          isRequired={props.params.isRequired}
          onToggleSensitivePath={props.params.onToggleSensitivePath}
          onPatch={props.params.onPatch}
        />
      }
    />
  );
}
