/** Prompts for live transport/capability probes, not general agent policy. */
export function buildCronToolCapabilityProbePrompt(file: string, cap: string): string {
  const instruction =
    cap === "bash"
      ? `Use the exec tool to run cat ${JSON.stringify(file)}.`
      : `Use the read tool to read ${JSON.stringify(file)}.`;
  // Codex may expose inert exec/wait wrappers even when no nested tools are allowed.
  // Ask about the requested capability, not the existence of those wrappers.
  return `${instruction} Reply with the file contents. If the requested tool is unavailable, reply exactly NO_TOOLS. Do not substitute another tool.`;
}

export function buildCanonicalTextReplyProbePrompt(marker: string): string {
  // This scenario verifies canonical native history, not outbound message delivery.
  return `Reply exactly ${marker} as final assistant text. Do not call tools or send a message.`;
}
