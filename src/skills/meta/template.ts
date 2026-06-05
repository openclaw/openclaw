const DEFAULT_TEMPLATE_ARG_MAX_DEPTH = 20;

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readPath(context: Record<string, unknown>, path: string): unknown {
  let current: unknown = context;
  for (const segment of path.split(".")) {
    if (!current || (typeof current !== "object" && typeof current !== "function")) {
      return undefined;
    }
    if (!Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringifyTemplateValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

export function renderMetaTemplate(
  template: string | undefined,
  context: Record<string, unknown>,
): string {
  if (!template) {
    return "";
  }

  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, path: string) =>
    stringifyTemplateValue(readPath(context, path)),
  );
}

export function renderMetaTemplateArgs(
  value: unknown,
  context: Record<string, unknown>,
  state: {
    depth?: number;
    maxDepth?: number;
    stack?: WeakSet<object>;
  } = {},
): unknown {
  const depth = state.depth ?? 0;
  const maxDepth = state.maxDepth ?? DEFAULT_TEMPLATE_ARG_MAX_DEPTH;
  if (depth > maxDepth) {
    throw new Error(`Meta template args exceed max depth of ${maxDepth}`);
  }
  if (typeof value === "string") {
    return renderMetaTemplate(value, context);
  }
  if (Array.isArray(value)) {
    const stack = state.stack ?? new WeakSet<object>();
    if (stack.has(value)) {
      throw new Error("Meta template args contain a cycle");
    }
    stack.add(value);
    try {
      return value.map((entry) =>
        renderMetaTemplateArgs(entry, context, {
          depth: depth + 1,
          maxDepth,
          stack,
        }),
      );
    } finally {
      stack.delete(value);
    }
  }
  if (isPlainRecord(value)) {
    const stack = state.stack ?? new WeakSet<object>();
    if (stack.has(value)) {
      throw new Error("Meta template args contain a cycle");
    }
    stack.add(value);
    try {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          renderMetaTemplateArgs(entry, context, {
            depth: depth + 1,
            maxDepth,
            stack,
          }),
        ]),
      );
    } finally {
      stack.delete(value);
    }
  }
  return value;
}
