/**
 * Builds the welcome message shown when the TUI starts up.
 */
export function buildWelcomeMessage(opts: {
  model: string;
  ollamaHealthy: boolean;
  ollamaVersion?: string;
  modelsCount: number;
}): string {
  const lines: string[] = ["🌿 gclaw — local-first AI, rooted in privacy", ""];

  if (opts.ollamaHealthy) {
    const versionSuffix = opts.ollamaVersion ? ` (${opts.ollamaVersion})` : "";
    lines.push(`  Model:    ${opts.model}`);
    lines.push(
      `  Status:   Ollama connected ✓${versionSuffix} | ${opts.modelsCount} model${opts.modelsCount === 1 ? "" : "s"} loaded`,
    );
    lines.push("");
    lines.push("  Type a message to start chatting.");
    lines.push("  Press /help for commands, Ctrl+C to exit.");
  } else {
    lines.push("  ⚠ Ollama not detected. Start it with: ollama serve");
    lines.push("  Then pull a model: ollama pull gemma3:4b");
  }

  return lines.join("\n");
}
