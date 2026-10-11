import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ConfigFormStructuredDraftProps as SolidDraftProps } from "./config-form-structured-draft.tsx";
import { isSupportedConfigValueValid } from "./config-form.constraints.ts";
import type { ConfigNodeRenderParams, ConfigNodeRenderer } from "./config-form.node.shared.ts";
import type { LegacyNodeRenderer } from "./config-form.node.ts";
import { schemaType } from "./config-form.shared.ts";

export type ConfigFormStructuredDraftProps = Omit<SolidDraftProps, "renderNode"> & {
  renderNode?: LegacyNodeRenderer;
  renderSolidNode?: ConfigNodeRenderer;
};

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-config-form-structured-draft": HTMLElement & {
      props?: ConfigFormStructuredDraftProps;
    };
  }
}
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
    initialValue = structuredClone(schemaDefault);
  }
  return isSupportedConfigValueValid(params.schema, initialValue) ? undefined : initialValue;
}
