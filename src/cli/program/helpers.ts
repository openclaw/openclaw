export function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function parsePositiveIntOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      return undefined;
    }
    return value > 0 ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^[0-9]+$/.test(trimmed)) {
      return undefined;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return undefined;
    }
    return parsed;
  }
  return undefined;
}

export function resolveActionArgs(actionCommand?: import("commander").Command): string[] {
  if (!actionCommand) {
    return [];
  }
  const args = (actionCommand as import("commander").Command & { args?: string[] }).args;
  return Array.isArray(args) ? args : [];
}
