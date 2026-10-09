export function parseConfigValue(raw: string): {
  value?: unknown;
  error?: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { error: "Missing value." };
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { value: JSON.parse(trimmed) };
    } catch (err) {
      return { error: `Invalid JSON: ${String(err)}` };
    }
  }

  if (trimmed === "true" || trimmed === "false" || trimmed === "null") {
    return { value: trimmed === "null" ? null : trimmed === "true" };
  }

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) {
      return { value: num };
    }
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return { value: JSON.parse(trimmed) };
    } catch {
      return { value: trimmed.slice(1, -1) };
    }
  }

  return { value: trimmed };
}
