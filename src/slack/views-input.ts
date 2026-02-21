type SlackModalView = Record<string, unknown>;

function parseViewJson(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("view must be valid JSON");
  }
}

function assertModalViewObject(raw: unknown): asserts raw is SlackModalView {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("view must be an object");
  }
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== "string" || type.trim().length === 0) {
    throw new Error("view.type is required");
  }
  if (type !== "modal") {
    throw new Error("view.type must be modal");
  }
}

export function parseSlackModalViewInput(raw: unknown): SlackModalView {
  const parsed = typeof raw === "string" ? parseViewJson(raw) : raw;
  assertModalViewObject(parsed);
  return parsed;
}
