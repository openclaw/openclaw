/** The three generic setup adapters qualified for independent custom endpoints. */
export const CUSTOM_ENDPOINT_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
] as const;
export type CustomEndpointApi = (typeof CUSTOM_ENDPOINT_APIS)[number];
export type CustomEndpointModelInput = "text" | "image" | "audio" | "video";
/** Only user-edited fields cross the write boundary; null removes an authored token limit. */
export type CustomEndpointModelEdits = {
  name?: string;
  textInput?: boolean;
  imageInput?: boolean;
  reasoning?: boolean;
  contextWindow?: number | null;
  maxTokens?: number | null;
};
export type CustomEndpointModelUpdate = {
  id: string;
  existingId?: string;
  edits: CustomEndpointModelEdits;
};
/** Display values can be materialized defaults and are never submitted as edit intent. */
export type CustomEndpointModel = {
  id: string;
  name: string;
  input?: CustomEndpointModelInput[];
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  existingId?: string;
  edits: CustomEndpointModelEdits;
};
export type CustomEndpointDraft = {
  provider: string;
  baseUrl: string;
  api: CustomEndpointApi;
  noAuth: boolean;
  models: CustomEndpointModel[];
};

/** Toggle only the declared modality, retaining other modalities and untouched omissions. */
export function customEndpointModelInputs(
  input: CustomEndpointModelInput[] | undefined,
  edits: CustomEndpointModelEdits,
): CustomEndpointModelInput[] | undefined {
  if (edits.textInput === undefined && edits.imageInput === undefined) {
    return input;
  }
  // Independent custom models inherit text input (config/defaults.ts).
  // Materialize that baseline only for an explicit modality edit.
  let next = [...(input ?? ["text"])];
  for (const [kind, enabled] of [
    ["text", edits.textInput],
    ["image", edits.imageInput],
  ] as const) {
    if (enabled === undefined) {
      continue;
    }
    const index = next.indexOf(kind);
    if (enabled && index < 0) {
      next.push(kind);
    } else if (!enabled && index >= 0) {
      next = next.filter((value) => value !== kind);
    }
  }
  return next;
}
