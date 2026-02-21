type AgentDeltaEvent = {
  runId: string;
  stream: "assistant";
  data: { delta: string };
};

export function extractPayloadText(result: unknown): string {
  const record = result as Record<string, unknown>;
  const payloads = Array.isArray(record.payloads) ? record.payloads : [];
  const texts = payloads
    .map((p) => (p && typeof p === "object" ? (p as Record<string, unknown>).text : undefined))
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  return texts.join("\n").trim();
}

export function buildAssistantDeltaResult(params: {
  opts: unknown;
  emit: (event: AgentDeltaEvent) => void;
  deltas: string[];
  text: string;
}): { payloads: Array<{ text: string }> } {
  const runId = (params.opts as { runId?: string } | undefined)?.runId ?? "";
  for (const delta of params.deltas) {
    params.emit({ runId, stream: "assistant", data: { delta } });
  }
  return { payloads: [{ text: params.text }] };
}
