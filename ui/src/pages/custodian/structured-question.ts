import type { SystemAgentChatQuestion } from "@openclaw/gateway-protocol";
import { normalizeNullableString as nonEmptyString } from "@openclaw/normalization-core/string-coerce";
import type { SchemaContract } from "../../../../packages/gateway-protocol/src/schema-contract.js";

export type CustodianStructuredQuestion = SchemaContract<
  Omit<SystemAgentChatQuestion, "isOther"> & { isOther: boolean }
>;

/** Normalize display text; the Gateway owns the question and option contract. */
export function parseCustodianQuestion(
  value: SystemAgentChatQuestion | undefined,
): CustodianStructuredQuestion | null {
  if (!value) {
    return null;
  }
  const [id, header, question] = [value.id, value.header, value.question].map(nonEmptyString);
  if (!id || !header || !question) {
    return null;
  }
  const options: CustodianStructuredQuestion["options"] = [];
  for (const option of value.options) {
    const label = nonEmptyString(option.label);
    if (!label) {
      return null;
    }
    const [description, reply] = [option.description, option.reply].map(nonEmptyString);
    options.push({
      label,
      ...(description ? { description } : {}),
      ...(option.recommended === true ? { recommended: true } : {}),
      ...(reply ? { reply } : {}),
    });
  }
  return {
    id,
    header,
    question,
    options,
    isOther: value.isOther === true,
    ...(value.skipAction === "exit" ? { skipAction: "exit" as const } : {}),
  };
}
