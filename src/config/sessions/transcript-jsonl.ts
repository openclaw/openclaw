export function serializeJsonlLines(lines: readonly string[]): string {
  // Transcript readers expect every persisted entry batch to end with a newline.
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
