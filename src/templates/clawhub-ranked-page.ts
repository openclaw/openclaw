import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ClawHubRequestError,
  fetchClawHubJson,
  type ClawHubFetchOptions,
} from "../infra/clawhub-client.js";
import { ClawHubSourceError } from "./clawhub-source-artifact.js";

export const LEGACY_TEMPLATE_CURSOR_PREFIX = "template-page:";

/** The registry owns rank, public visibility and continuation on the same result set. */
export async function fetchRankedTemplatePage(
  params: ClawHubFetchOptions & {
    query?: string;
    category?: string;
    limit: number;
    cursor?: string;
  },
): Promise<{ items: unknown[]; nextCursor: string | null } | undefined> {
  let page: unknown;
  try {
    page = await fetchClawHubJson<unknown>({
      ...params,
      skipAuth: true,
      path: "/api/v1/templates/catalog-page",
      search: {
        q: params.query,
        category: params.category,
        limit: String(params.limit),
        cursor: params.cursor,
      },
    });
  } catch (error) {
    // Only an older registry's missing first page can select the legacy feed.
    // A cursor cannot continue in a different result set, even during a rollback.
    if (!params.cursor && error instanceof ClawHubRequestError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
  if (!isRecord(page) || !Array.isArray(page.items) || page.items.length > params.limit) {
    throw new ClawHubSourceError(
      "clawhub_catalog_invalid",
      "ClawHub returned a malformed ranked Template page.",
    );
  }
  const { nextCursor } = page;
  if (
    nextCursor !== null &&
    (typeof nextCursor !== "string" ||
      !nextCursor ||
      nextCursor.length > 4096 ||
      nextCursor === params.cursor ||
      nextCursor.startsWith(LEGACY_TEMPLATE_CURSOR_PREFIX))
  ) {
    throw new ClawHubSourceError(
      "clawhub_catalog_cursor_invalid",
      "ClawHub returned an invalid ranked Template cursor. Start a new search.",
    );
  }
  return { items: page.items, nextCursor };
}
