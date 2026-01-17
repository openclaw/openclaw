export function normalizeInboundTextNewlines(input: string): string {
  const text = input.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (text.includes("\n")) return text;
  if (!text.includes("\\n")) return text;
  return text.replaceAll("\\n", "\n");
}

