import { asNullableRecord as readThemeRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  THEME_ID_PATTERN,
  ThemeValidationError,
  describeThemeLabel,
  requireThemeId,
  type ImportedCustomTheme,
} from "../../app/custom-theme.ts";
import { MissingThemeTokenError, normalizeThemePalette } from "../../app/theme-palette.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { readResponseTextWithLimit } from "../../lib/response-body.ts";

registerEnglishCatalog(registerSettingsEnglish);

const TWEAKCN_HOSTS = new Set(["tweakcn.com", "www.tweakcn.com"]);
const MAX_TWEAKCN_THEME_BYTES = 200_000;
const TWEAKCN_FETCH_TIMEOUT_MS = 10_000;

function normalizeThemeIdFromPath(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  const themeId = segments.at(-1);
  if (
    themeId &&
    ((segments.length === 2 && segments[0] === "themes") ||
      (segments.length === 3 && segments[0] === "r" && segments[1] === "themes"))
  ) {
    requireThemeId(themeId);
    return themeId;
  }
  return null;
}

function normalizePastedThemeInput(input: string): string {
  const normalized = normalizeOptionalString(input);
  if (!normalized) {
    throw new Error(t("configView.appearance.importErrors.empty"));
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

export function formatThemeValidationError(error: unknown): string {
  if (error instanceof MissingThemeTokenError) {
    return t("configView.appearance.themeImport.missingToken", { token: error.message });
  }
  if (error instanceof ThemeValidationError) {
    return error.message
      ? t("configView.appearance.themeImport.invalidToken", { token: error.message })
      : t("configView.appearance.themeImport.invalidLink");
  }
  return formatUiError(error);
}

export async function importCustomThemeFromUrl(input: string): Promise<ImportedCustomTheme> {
  try {
    return await importTheme(input);
  } catch (error) {
    if (error instanceof ThemeValidationError) {
      throw new Error(formatThemeValidationError(error), { cause: error });
    }
    throw error;
  }
}

async function importTheme(input: string): Promise<ImportedCustomTheme> {
  const normalized = normalizePastedThemeInput(input);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(t("configView.appearance.importErrors.invalidUrl"));
  }
  if (!TWEAKCN_HOSTS.has(parsed.hostname)) {
    throw new Error(t("configView.appearance.importErrors.unsupportedHost"));
  }
  let themeId = normalizeThemeIdFromPath(parsed.pathname);
  if (!themeId) {
    themeId =
      parsed.searchParams.get("theme") ??
      parsed.searchParams.get("themeId") ??
      parsed.searchParams.get("id");
    if (!themeId) {
      throw new Error(t("configView.appearance.importErrors.unsupportedLink"));
    }
    requireThemeId(themeId);
  }
  const sourceUrl = `https://tweakcn.com/themes/${themeId}`;
  const fetchUrl = `https://tweakcn.com/r/themes/${themeId}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TWEAKCN_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(fetchUrl, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    const responseUrlText = response.url;
    if (responseUrlText) {
      let responseUrl: URL;
      try {
        responseUrl = new URL(responseUrlText);
      } catch {
        throw new Error(t("configView.appearance.importErrors.responseUrl"));
      }
      if (responseUrl.protocol !== "https:" || !TWEAKCN_HOSTS.has(responseUrl.hostname)) {
        throw new Error(t("configView.appearance.importErrors.redirect"));
      }
    }
    if (!response.ok) {
      throw new Error(
        t("configView.appearance.importErrors.http", { status: String(response.status) }),
      );
    }
    const text = await readResponseTextWithLimit(response, {
      maxBytes: MAX_TWEAKCN_THEME_BYTES,
      tooLargeMessage: t("configView.appearance.importErrors.tooLarge"),
      missingBodyMessage: t("configView.appearance.importErrors.unreadable"),
    });
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new Error(t("configView.appearance.importErrors.invalidJson"));
    }
    const record = readThemeRecord(payload);
    const cssVars = readThemeRecord(record?.cssVars);
    const light = readThemeRecord(cssVars?.light);
    const dark = readThemeRecord(cssVars?.dark);
    const shared = cssVars?.theme === undefined ? undefined : readThemeRecord(cssVars.theme);
    if (!record || !cssVars || !light || !dark || shared === null) {
      throw new Error(t("configView.appearance.importErrors.invalidTheme"));
    }
    return {
      sourceUrl,
      themeId,
      label: describeThemeLabel(normalizeOptionalString(record.name)),
      importedAt: new Date().toISOString(),
      light: normalizeThemePalette("light", light, shared),
      dark: normalizeThemePalette("dark", dark, shared),
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(t("configView.appearance.importErrors.timeout"), { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
