import {
  normalizeJsonSchemaForTypeBox,
  type JsonSchemaValue,
} from "@openclaw/normalization-core/json-schema";
import { Check } from "typebox/schema";

/** Loaded only for advertised inline contracts, not ordinary Control UI startup. */
export function createInlinePayloadCheck(schema: JsonSchemaValue): (payload: unknown) => boolean {
  // Registration already admitted the schema. Interpret here to preserve the browser CSP.
  const normalized = normalizeJsonSchemaForTypeBox(schema, { format: "annotation" });
  return (payload) => Check(normalized, payload);
}
