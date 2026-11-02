import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isSupportedConfigValueValid } from "./config-form.constraints.ts";
import type { ConfigNodeRenderParams, ConfigNodeRenderer } from "./config-form.node.shared.ts";
import { schemaType } from "./config-form.shared.ts";

export type ConfigFormStructuredDraftProps = {
  identity: string;
  sourceIdentity: unknown;
  initialValue: Record<string, unknown> | unknown[];
  params: ConfigNodeRenderParams;
  renderNode: ConfigNodeRenderer;
};

export function resolveStructuredDraftInitialValue(
  params: ConfigNodeRenderParams,
): Record<string, unknown> | unknown[] | undefined {
  if (
    params.value !== undefined ||
    params.isRequired === true ||
    params.structuredDraftOwner === true
  ) {
    return undefined;
  }
  const type = schemaType(params.schema);
  if (type !== "object" && type !== "array") {
    return undefined;
  }
  const schemaDefault = params.schema.default;
  let initialValue: Record<string, unknown> | unknown[] = type === "object" ? {} : [];
  if (
    (type === "object" && isRecord(schemaDefault)) ||
    (type === "array" && Array.isArray(schemaDefault))
  ) {
    initialValue = schemaDefault;
  }
  return isSupportedConfigValueValid(params.schema, initialValue) ? undefined : initialValue;
}
