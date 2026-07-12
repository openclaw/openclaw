// Parses command output that may include warnings before or after a JSON object.
export function parsePossiblyNoisyJsonObject(
  stdout: string,
  matchesPayload?: (payload: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  const trimmed = stdout.trim();
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] !== "{") {
      continue;
    }
    const end = findJsonObjectEnd(trimmed, i);
    if (end === undefined) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed.slice(i, end + 1)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const payload = parsed as Record<string, unknown>;
        if (!matchesPayload || matchesPayload(payload) || (i === 0 && end === trimmed.length - 1)) {
          return payload;
        }
      }
    } catch {
      // Keep looking: diagnostics can contain brace pairs before the real JSON.
    }
  }
  return JSON.parse(trimmed) as Record<string, unknown>;
}

function findJsonObjectEnd(value: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < value.length; i += 1) {
    const ch = value[i] ?? "";
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch !== "}") {
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return i;
    }
  }
  return undefined;
}
