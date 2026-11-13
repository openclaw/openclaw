export const DEFAULT_GRADIUM_VOICE_ID = "YTpq7expH9539ERJ";

/** Native unary payload shared by direct and catalog-scoped proxy transports. */
export function buildGradiumSpeechRequestBody(params: {
  text: string;
  voiceId: string;
  outputFormat: "wav" | "opus" | "ulaw_8000";
}) {
  return {
    text: params.text,
    voice_id: params.voiceId,
    only_audio: true,
    output_format: params.outputFormat,
    json_config: JSON.stringify({ padding_bonus: 0 }),
  };
}
