export function extractCompanionCommandQuestion(message: string): string {
  return message
    .trim()
    .replace(/^\/(?:btw|side)(?::\s*|\s+|$)/i, "")
    .trim();
}
