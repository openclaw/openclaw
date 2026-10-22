import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  CUSTOM_ENDPOINT_APIS,
  type CustomEndpointApi,
  type CustomEndpointDraft,
  type CustomEndpointModel,
  type CustomEndpointModelInput,
} from "../../../../src/shared/custom-endpoint.js";

export const newEndpointModel = (id = ""): CustomEndpointModel => ({
  id,
  name: id,
  edits: id ? { name: id } : {},
});
export function customEndpointApi(value: unknown): CustomEndpointApi | undefined {
  return CUSTOM_ENDPOINT_APIS.find((entry) => entry === value);
}
export function readEndpointDraft(
  provider: string,
  entry: Record<string, unknown>,
): CustomEndpointDraft {
  return {
    provider,
    baseUrl: typeof entry.baseUrl === "string" ? entry.baseUrl : "",
    api: customEndpointApi(entry.api) ?? "openai-completions",
    noAuth: entry.auth === "none",
    models: (Array.isArray(entry.models) ? entry.models : []).flatMap((value) => {
      const row = asNullableRecord(value);
      if (!row || typeof row.id !== "string") {
        return [];
      }
      return [
        {
          id: row.id,
          name: typeof row.name === "string" ? row.name : row.id,
          input: Array.isArray(row.input)
            ? row.input.filter(
                (kind): kind is CustomEndpointModelInput =>
                  kind === "text" || kind === "image" || kind === "audio" || kind === "video",
              )
            : undefined,
          reasoning: typeof row.reasoning === "boolean" ? row.reasoning : undefined,
          contextWindow: typeof row.contextWindow === "number" ? row.contextWindow : undefined,
          maxTokens: typeof row.maxTokens === "number" ? row.maxTokens : undefined,
          existingId: row.id,
          edits: {},
        } satisfies CustomEndpointModel,
      ];
    }),
  };
}
