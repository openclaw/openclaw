export type ControlUiCspExtraSources = {
  scriptSrc?: string[];
  styleSrc?: string[];
  styleSrcElem?: string[];
  imgSrc?: string[];
  fontSrc?: string[];
  connectSrc?: string[];
  workerSrc?: string[];
};

export type ControlUiCspOptions = {
  extraSources?: ControlUiCspExtraSources;
};

type ControlUiCspDirective = keyof ControlUiCspExtraSources;

const BASE_DIRECTIVES: Record<ControlUiCspDirective, string[]> = {
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  styleSrcElem: ["'self'"],
  imgSrc: ["'self'", "data:", "https:"],
  fontSrc: ["'self'"],
  connectSrc: ["'self'", "ws:", "wss:"],
  workerSrc: ["'self'", "blob:"],
};

const SAFE_KEYWORDS = new Set(["'self'", "'none'"]);
const SAFE_SCHEMES = new Set(["data:", "blob:", "http:", "https:", "ws:", "wss:"]);

function toDirectiveName(directive: ControlUiCspDirective): string {
  return directive.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function normalizeCspSourceToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed || /[\s;,]/.test(trimmed)) {
    return null;
  }
  if (SAFE_KEYWORDS.has(trimmed) || SAFE_SCHEMES.has(trimmed)) {
    return trimmed;
  }
  if (
    /^(https?|wss?):\/\/\*\.[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(?::\d+)?$/i.test(
      trimmed,
    )
  ) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function mergeSources(base: string[], extra: string[] | undefined): string[] {
  if (!extra?.length) {
    return [...base];
  }
  const merged = [...base];
  for (const token of extra) {
    const normalized = normalizeCspSourceToken(token);
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }
  return merged;
}

export function buildControlUiCspHeader(options?: ControlUiCspOptions): string {
  const extra = options?.extraSources;
  // Control UI: block framing, block inline scripts, keep styles permissive
  // (UI uses a lot of inline style attributes in templates).
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    ...(Object.keys(BASE_DIRECTIVES) as ControlUiCspDirective[]).map((directive) => {
      const sources = mergeSources(BASE_DIRECTIVES[directive], extra?.[directive]);
      return `${toDirectiveName(directive)} ${sources.join(" ")}`;
    }),
  ].join("; ");
}
