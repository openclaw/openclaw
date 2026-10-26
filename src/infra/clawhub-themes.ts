import { createHash } from "node:crypto";
import { Value } from "typebox/value";
import {
  CLAWHUB_THEME_PAGE_SIZE,
  ThemeReleaseResultSchema,
  ThemesBrowseResultSchema,
  type ThemeRelease,
  type ThemesBrowseParams,
  type ThemesBrowseResult,
  type ThemesInstallParams,
} from "../../packages/gateway-protocol/src/schema/themes.js";
import { normalizeThemeDefinition } from "../../packages/gateway-protocol/src/theme.js";
import { fetchClawHubJson } from "./clawhub-client.js";

const THEME_RESPONSE_MAX_BYTES = 128 * 1024;

/** Public data-only catalog reads never load or transmit ClawHub credentials. */
export async function browseClawHubThemes(params: ThemesBrowseParams): Promise<ThemesBrowseResult> {
  const limit = params.limit ?? CLAWHUB_THEME_PAGE_SIZE;
  const response = await fetchClawHubJson<unknown>({
    path: "/api/v1/themes",
    search: { limit: String(limit), cursor: params.cursor, q: params.query },
    skipAuth: true,
    maxResponseBytes: THEME_RESPONSE_MAX_BYTES,
  });
  if (!Value.Check(ThemesBrowseResultSchema, response) || response.items.length > limit) {
    throw new Error("Malformed ClawHub theme catalog response.");
  }
  const ids = new Set<string>();
  for (const item of response.items) {
    if (item.author.handle !== item.id.split("/")[0] || ids.has(item.id)) {
      throw new Error("Malformed ClawHub theme catalog identity.");
    }
    ids.add(item.id);
  }
  return response;
}

/** The sole remote release boundary: validate metadata, safe data and canonical digest. */
export async function getClawHubThemeRelease(params: ThemesInstallParams): Promise<ThemeRelease> {
  const response = await fetchClawHubJson<unknown>({
    path: "/api/v1/themes/" + params.id.split("/").map(encodeURIComponent).join("/"),
    search: { version: params.version },
    skipAuth: true,
    maxResponseBytes: THEME_RESPONSE_MAX_BYTES,
  });
  if (!Value.Check(ThemeReleaseResultSchema, response)) {
    throw new Error("Malformed ClawHub theme release response.");
  }
  const { item } = response;
  if (
    item.id !== params.id ||
    item.version !== params.version ||
    item.author.handle !== params.id.split("/")[0]
  ) {
    throw new Error("ClawHub returned a different theme or version than requested.");
  }
  const definition = normalizeThemeDefinition(item.definition);
  // ClawHub hashes JSON in the existing normalizer's deterministic property order.
  const sha256 = createHash("sha256").update(JSON.stringify(definition)).digest("hex");
  if (sha256 !== item.sha256) {
    throw new Error("ClawHub theme definition checksum does not match its release.");
  }
  return { ...item, definition };
}

/** Stable across releases; owner identity prevents same-name themes from overwriting each other. */
export function clawHubThemeLocalId(id: string): string {
  const name = id.split("/")[1] ?? "theme";
  return `ch-${name.slice(0, 28)}-${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}
