export function makeUserMessage(content: string, timestamp: number) {
  return { role: "user" as const, content, timestamp };
}
