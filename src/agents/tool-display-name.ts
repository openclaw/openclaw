export function normalizeToolDisplayName(name?: string): string {
  return (name ?? "tool").trim();
}

export function defaultTitle(name: string): string {
  const cleaned = name.replace(/_/g, " ").trim();
  if (!cleaned) {
    return "Tool";
  }
  return cleaned
    .split(/\s+/)
    .map((part) => `${part.at(0)?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}
