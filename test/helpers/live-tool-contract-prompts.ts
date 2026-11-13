/** Prompts for live transport/capability probes, not general agent policy. */
export function buildCronToolCapabilityProbePrompt(file: string, cap: string): string {
  const instruction =
    cap === "bash"
      ? `Use the exec tool to run cat ${JSON.stringify(file)}.`
      : `Use the read tool to read ${JSON.stringify(file)}.`;
  // Ask about the requested capability, not inert wrapper availability.
  return `${instruction} Reply with the file contents. If the requested tool is unavailable, reply exactly NO_TOOLS. Do not substitute another tool.`;
}
