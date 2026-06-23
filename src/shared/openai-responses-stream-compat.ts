export const OPENAI_RESPONSES_OUTPUT_TEXT_CONTENT_PART_TYPE = "output_text";
export const AZURE_RESPONSES_TEXT_CONTENT_PART_TYPE = "text";
export const OPENAI_RESPONSES_OUTPUT_TEXT_DELTA_EVENT_TYPE = "response.output_text.delta";
export const AZURE_RESPONSES_TEXT_DELTA_EVENT_TYPE = "response.text.delta";

export type ResponsesTextContentPartType =
  | typeof OPENAI_RESPONSES_OUTPUT_TEXT_CONTENT_PART_TYPE
  | typeof AZURE_RESPONSES_TEXT_CONTENT_PART_TYPE;

export type ResponsesTextDeltaEventType =
  | typeof OPENAI_RESPONSES_OUTPUT_TEXT_DELTA_EVENT_TYPE
  | typeof AZURE_RESPONSES_TEXT_DELTA_EVENT_TYPE;

export type AzureResponsesTextContentPart = {
  type: typeof AZURE_RESPONSES_TEXT_CONTENT_PART_TYPE;
  text: string;
};

export type AzureResponsesTextDeltaEvent = {
  type: typeof AZURE_RESPONSES_TEXT_DELTA_EVENT_TYPE;
  delta: string;
};

export function isResponsesTextContentPartType(
  type: unknown,
): type is ResponsesTextContentPartType {
  return (
    type === OPENAI_RESPONSES_OUTPUT_TEXT_CONTENT_PART_TYPE ||
    type === AZURE_RESPONSES_TEXT_CONTENT_PART_TYPE
  );
}

export function isResponsesTextDeltaEventType(type: unknown): type is ResponsesTextDeltaEventType {
  return (
    type === OPENAI_RESPONSES_OUTPUT_TEXT_DELTA_EVENT_TYPE ||
    type === AZURE_RESPONSES_TEXT_DELTA_EVENT_TYPE
  );
}

export function isAzureResponsesTextDeltaEventType(
  type: unknown,
): type is typeof AZURE_RESPONSES_TEXT_DELTA_EVENT_TYPE {
  return type === AZURE_RESPONSES_TEXT_DELTA_EVENT_TYPE;
}

export function isAzureResponsesTextDeltaEvent(event: {
  type?: unknown;
  delta?: unknown;
}): event is AzureResponsesTextDeltaEvent {
  return isAzureResponsesTextDeltaEventType(event.type) && typeof event.delta === "string";
}
