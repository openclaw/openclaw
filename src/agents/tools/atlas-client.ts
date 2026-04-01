type AtlasRequestOptions = {
  method?: "GET" | "POST";
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
};

export class AtlasHttpError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.name = "AtlasHttpError";
    this.status = status;
    this.payload = payload;
  }
}

function resolveAtlasBaseUrl() {
  const baseUrl = String(
    process.env.OPENCLAW_ATLAS_WEB_BASE_URL || process.env.ATLAS_WEB_BASE_URL || "",
  ).trim();
  if (!baseUrl) {
    throw new Error(
      "Atlas base URL is not configured. Set OPENCLAW_ATLAS_WEB_BASE_URL or ATLAS_WEB_BASE_URL.",
    );
  }
  return baseUrl.replace(/\/+$/, "");
}

function resolveAtlasToken() {
  return String(
    process.env.OPENCLAW_ATLAS_A2A_TOKEN ||
      process.env.ATLAS_A2A_TOKEN ||
      process.env.ATLAS_WEB_LOGS_TOKEN ||
      "",
  ).trim();
}

function buildAtlasUrl(
  pathname: string,
  query?: Record<string, string | number | boolean | null | undefined>,
) {
  const url = new URL(`${resolveAtlasBaseUrl()}${pathname}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value == null) {
      continue;
    }
    const normalized =
      typeof value === "boolean" ? (value ? "true" : "false") : String(value).trim();
    if (!normalized) {
      continue;
    }
    url.searchParams.set(key, normalized);
  }
  return url;
}

export async function atlasJsonRequest<T>(
  pathname: string,
  options: AtlasRequestOptions = {},
): Promise<T> {
  const method = options.method || "GET";
  const url = buildAtlasUrl(pathname, options.query);
  const headers = new Headers();
  const token = resolveAtlasToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(url, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const payload = text ? safeJsonParse(text) : null;
  if (!response.ok) {
    const errorMessage =
      payload && typeof payload === "object" && "error" in payload && payload.error
        ? String(payload.error)
        : text || `${method} ${pathname} failed with ${response.status}`;
    throw new AtlasHttpError(response.status, errorMessage, payload);
  }
  return payload as T;
}

function safeJsonParse(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}
