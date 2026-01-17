export function normalizeInboundTextNewlines(input: string): string {
  return input.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\\n", "\n");
}
