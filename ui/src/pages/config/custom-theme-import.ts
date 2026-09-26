import { asNullableRecord as readThemeRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  THEME_ID_PATTERN,
  describeThemeLabel,
  requireThemeId,
  type ImportedCustomTheme,
} from "../../app/custom-theme.ts";
import { normalizeThemePalette } from "../../app/theme-palette.ts";
import { readResponseTextWithLimit } from "../../lib/response-body.ts";

const TWEAKCN_HOSTS = new Set(["tweakcn.com", "www.tweakcn.com"]);
const MAX_TWEAKCN_THEME_BYTES = 200_000;
const TWEAKCN_FETCH_TIMEOUT_MS = 10_000;
type TweakcnThemeResolution = {
  sourceUrl: string;
  fetchUrl: string;
  themeId: string;
};

function normalizeThemeIdFromPath(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  const themeId = segments.at(-1);
  if (!themeId) {
    return null;
  }
  if (segments.length === 2 && segments[0] === "themes") {
    requireThemeId(themeId);
    return themeId;
  }
  if (segments.length === 3 && segments[0] === "r" && segments[1] === "themes") {
    requireThemeId(themeId);
    return themeId;
  }
  return null;
}

function normalizePastedThemeInput(input: string): string {
  const normalized = normalizeOptionalString(input);
  if (!normalized) {
    throw new Error("Paste a tweakcn theme link to import.");
  }
  const inputValue = normalized.replace(/[.,;:]+$/, "");
  if (THEME_ID_PATTERN.test(inputValue)) {
    return `https://tweakcn.com/themes/${inputValue}`;
  }
  if (inputValue.startsWith("/themes/") || inputValue.startsWith("/r/themes/")) {
    return `https://tweakcn.com${inputValue}`;
  }
  if (/^(?:www\.)?tweakcn\.com\//i.test(inputValue)) {
    return `https://${inputValue}`;
  }
  const embeddedUrl = inputValue
    .match(/https?:\/\/(?:www\.)?tweakcn\.com\/[^\s<>"')]+/i)?.[0]
    ?.replace(/[.,;:]+$/, "");
  return embeddedUrl ?? inputValue;
}

function normalizeThemeIdFromUrl(parsed: URL): string {
  const pathThemeId = normalizeThemeIdFromPath(parsed.pathname);
  if (pathThemeId) {
    return pathThemeId;
  }
  const queryThemeId =
    parsed.searchParams.get("theme") ??
    parsed.searchParams.get("themeId") ??
    parsed.searchParams.get("id");
  if (queryThemeId) {
    requireThemeId(queryThemeId);
    return queryThemeId;
  }
  throw new Error("Unsupported tweakcn link. Expected a theme share URL.");
}

function normalizeTweakcnThemeUrl(input: string): TweakcnThemeResolution {
  const normalized = normalizePastedThemeInput(input);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("Paste a full tweakcn URL.");
  }
  if (!TWEAKCN_HOSTS.has(parsed.hostname)) {
    throw new Error("Only tweakcn.com theme links are supported.");
  }
  const themeId = normalizeThemeIdFromUrl(parsed);
  return {
    themeId,
    sourceUrl: `https://tweakcn.com/themes/${themeId}`,
    fetchUrl: `https://tweakcn.com/r/themes/${themeId}`,
  };
}

function normalizeImportedCustomTheme(
  payload: unknown,
  resolution: Pick<TweakcnThemeResolution, "sourceUrl" | "themeId">,
): ImportedCustomTheme {
  const record = readThemeRecord(payload);
  const cssVars = readThemeRecord(record?.cssVars);
  const light = readThemeRecord(cssVars?.light);
  const dark = readThemeRecord(cssVars?.dark);
  const shared = cssVars?.theme === undefined ? undefined : readThemeRecord(cssVars.theme);
  if (!record || !cssVars || !light || !dark || shared === null) {
    throw new Error("tweakcn returned an invalid theme payload.");
  }
  return {
    sourceUrl: resolution.sourceUrl,
    themeId: resolution.themeId,
    label: describeThemeLabel(normalizeOptionalString(record.name)),
    importedAt: new Date().toISOString(),
    light: normalizeThemePalette("light", light, shared),
    dark: normalizeThemePalette("dark", dark, shared),
  };
}

function assertTweakcnResponseUrl(value: string | undefined) {
  if (!value) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Unexpected tweakcn import response URL.");
  }
  if (parsed.protocol !== "https:" || !TWEAKCN_HOSTS.has(parsed.hostname)) {
    throw new Error("Unexpected redirect during tweakcn import.");
  }
}

async function readJsonResponseWithLimit(response: Response): Promise<unknown> {
  const text = await readResponseTextWithLimit(response, {
    maxBytes: MAX_TWEAKCN_THEME_BYTES,
    tooLargeMessage: "tweakcn theme payload is too large.",
    missingBodyMessage: "tweakcn returned an unreadable theme payload.",
  });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("tweakcn returned invalid JSON.");
  }
}

export async function importCustomThemeFromUrl(
  input: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ImportedCustomTheme> {
  const resolution = normalizeTweakcnThemeUrl(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TWEAKCN_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(resolution.fetchUrl, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    assertTweakcnResponseUrl(response.url);
    if (!response.ok) {
      throw new Error(`tweakcn import failed (${response.status}).`);
    }
    const payload = await readJsonResponseWithLimit(response);
    return normalizeImportedCustomTheme(payload, resolution);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("tweakcn import timed out.", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
