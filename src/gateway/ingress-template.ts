export type IngressTemplateContext = {
  payload: Record<string, unknown>;
  headers?: Record<string, string>;
  url?: URL;
  path?: string;
};

const BLOCKED_PATH_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function renderIngressTemplate(template: string, ctx: IngressTemplateContext): string {
  if (!template) {
    return "";
  }
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, expr: string) => {
    const value = resolveIngressTemplateExpr(expr.trim(), ctx);
    if (value === undefined || value === null) {
      return "";
    }
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return JSON.stringify(value);
  });
}

export function renderOptionalIngressTemplate(
  template: string | undefined,
  ctx: IngressTemplateContext,
): string | undefined {
  if (!template) {
    return undefined;
  }
  const rendered = renderIngressTemplate(template, ctx).trim();
  return rendered ? rendered : undefined;
}

function resolveIngressTemplateExpr(expr: string, ctx: IngressTemplateContext): unknown {
  if (expr === "path") {
    return ctx.path;
  }
  if (expr === "now") {
    return new Date().toISOString();
  }
  if (expr.startsWith("headers.")) {
    return getByPath(ctx.headers ?? {}, expr.slice("headers.".length));
  }
  if (expr.startsWith("query.")) {
    return getByPath(
      ctx.url ? Object.fromEntries(ctx.url.searchParams.entries()) : {},
      expr.slice("query.".length),
    );
  }
  if (expr.startsWith("payload.")) {
    return getByPath(ctx.payload, expr.slice("payload.".length));
  }
  return getByPath(ctx.payload, expr);
}

function getByPath(input: Record<string, unknown>, pathExpr: string): unknown {
  if (!pathExpr) {
    return undefined;
  }
  const parts: Array<string | number> = [];
  const re = /([^.[\]]+)|(\[(\d+)\])/g;
  let match = re.exec(pathExpr);
  while (match) {
    if (match[1]) {
      parts.push(match[1]);
    } else if (match[3]) {
      parts.push(Number(match[3]));
    }
    match = re.exec(pathExpr);
  }
  let current: unknown = input;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof part === "number") {
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current[part] as unknown;
      continue;
    }
    if (BLOCKED_PATH_KEYS.has(part)) {
      return undefined;
    }
    if (typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
