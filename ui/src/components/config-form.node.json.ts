import { nothing, type TemplateResult } from "lit";
import {
  getSensitiveRenderState,
  jsonValue,
  renderFieldRow,
  renderJsonTextareaControl,
  renderSchemaDefaultDescription,
  resolveConfigFieldPresentation,
  type ConfigNodeRenderParams,
} from "./config-form.node.shared.ts";

export function renderJsonTextarea(params: ConfigNodeRenderParams): TemplateResult {
  const { schema, value, path, hints, disabled, onPatch } = params;
  const field = resolveConfigFieldPresentation(params);
  const fallback = jsonValue(value !== undefined ? value : schema.default);
  const sensitiveState = getSensitiveRenderState({
    path,
    value,
    hints,
    revealSensitive: params.revealSensitive ?? false,
    isSensitivePathRevealed: params.isSensitivePathRevealed,
  });
  const control = renderJsonTextareaControl({
    schema,
    path,
    ariaLabel: field.label,
    descriptionId: field.helpId,
    sourceValue: params.sourceIdentity ?? value,
    fallback,
    rows: 3,
    sensitiveState,
    disabled,
    isRequired: params.isRequired,
    onToggleSensitivePath: params.onToggleSensitivePath,
    onPatch,
  });

  return renderFieldRow({
    ...field,
    defaultDescription: sensitiveState.isRedacted
      ? nothing
      : renderSchemaDefaultDescription(schema, value),
    stacked: true,
    control,
  });
}
