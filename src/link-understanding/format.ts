export function formatLinkUnderstandingBody(params: { body?: string; outputs: string[] }): string {
  const outputs: string[] = [];
  for (const output of params.outputs) {
    const trimmed = output.trim();
    if (trimmed) {
      outputs.push(trimmed);
    }
  }
  if (outputs.length === 0) {
    return params.body ?? "";
  }

  const base = (params.body ?? "").trim();
  if (!base) {
    return outputs.join("\n");
  }
  return `${base}\n\n${outputs.join("\n")}`;
}
