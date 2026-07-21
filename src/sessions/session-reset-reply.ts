/** Formats the acknowledgement shared by chat and Gateway session reset paths. */
export function formatSessionResetAck(params: {
  reason: "new" | "reset";
  runtimeStatus?: {
    model: string;
    thinking: string;
  };
}): string {
  const text = params.reason === "new" ? "✅ New session started." : "✅ Session reset.";
  if (!params.runtimeStatus) {
    return text;
  }
  return `${text}\nModel: ${params.runtimeStatus.model}\nThink: ${params.runtimeStatus.thinking}`;
}
