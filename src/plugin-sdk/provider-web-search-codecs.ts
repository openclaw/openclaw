import { resolveSiteName } from "../agents/tools/web-search-provider-common.js";
import { wrapWebContent } from "../security/external-content.js";
import {
  asOptionalObjectRecord,
  asNonArrayRecord,
  filterStringEntries,
  isRecord,
  normalizeOptionalString,
  normalizeTrimmedStringList,
} from "./string-coerce-runtime.js";

function resultRows(payload: unknown, count: number): Record<string, unknown>[] {
  const rows = asOptionalObjectRecord(payload)?.results;
  return (Array.isArray(rows) ? rows.filter(isRecord) : []).slice(0, count);
}

const wrapped = (text: string) => (text ? wrapWebContent(text, "web_search") : "");
const string = (value: unknown) => (typeof value === "string" ? value : "");

/** Wire codecs shared by native search plugins and credential-scoped routers.
 * Authentication, admission, fetch policy, limits and caching belong to the caller.
 */
export const nativeWebSearchCodecs = {
  "deepseek.search": {
    method: "POST",
    request(endpoint: string, query: string, count: number) {
      return { url: endpoint, body: { query, count, need_content: false } };
    },
    readResults: readDeepSeekSearchResults,
    results(payload: unknown, count: number) {
      const { results } = readDeepSeekSearchResults(payload, count);
      for (const row of results) {
        row.title = wrapped(row.title);
        row.snippet = row.snippet ? wrapped(row.snippet) : undefined;
      }
      return results;
    },
  },
  "brave.search": {
    method: "GET",
    request(endpoint: string, query: string, count: number) {
      const url = new URL(endpoint);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(count));
      return { url: url.href };
    },
    results(payload: unknown, count: number) {
      return resultRows(asOptionalObjectRecord(payload)?.web, count).map((entry) => {
        const url = string(entry.url);
        return {
          title: wrapped(string(entry.title)),
          url,
          description: wrapped(string(entry.description)),
          published: string(entry.page_age) || undefined,
          siteName: resolveSiteName(url) || undefined,
        };
      });
    },
  },
  "exa.search": {
    method: "POST",
    request(endpoint: string, query: string, count: number) {
      const body: Record<string, unknown> = {
        query,
        numResults: count,
        type: "auto",
        contents: { highlights: true },
      };
      return { url: endpoint, body };
    },
    results(payload: unknown, count: number) {
      return resultRows(payload, count).map((entry) => {
        const url = string(entry.url);
        const summary = normalizeOptionalString(entry.summary) ?? "";
        const description =
          normalizeTrimmedStringList(entry.highlights).join("\n") ||
          summary ||
          normalizeOptionalString(entry.text) ||
          "";
        const highlightScores = Array.isArray(entry.highlightScores)
          ? entry.highlightScores.filter(
              (score): score is number => typeof score === "number" && Number.isFinite(score),
            )
          : [];
        return Object.assign(
          {
            title: wrapped(string(entry.title)),
            url,
            description: wrapped(description),
            published: string(entry.publishedDate) || undefined,
            siteName: resolveSiteName(url) || undefined,
          },
          summary ? { summary: wrapped(summary) } : {},
          highlightScores.length ? { highlightScores } : {},
        );
      });
    },
  },
  "parallel.search": {
    method: "POST",
    request(endpoint: string, query: string | string[], count: number) {
      const body: Record<string, unknown> = {
        search_queries: Array.isArray(query) ? query : [query],
        advanced_settings: { max_results: count },
      };
      return { url: endpoint, body };
    },
    results(payload: unknown, count: number) {
      return resultRows(payload, count).map((entry) => {
        const url = string(entry.url);
        const published = string(entry.publish_date);
        const excerpts = filterStringEntries(entry.excerpts).map((text) =>
          wrapWebContent(text, "web_search"),
        );
        return Object.assign(
          {
            title: wrapped(string(entry.title)),
            url,
            description: excerpts.join("\n\n"),
            siteName: resolveSiteName(url) || undefined,
          },
          published ? { published } : {},
          excerpts.length ? { excerpts } : {},
        );
      });
    },
  },
  "searxng.search": {
    method: "GET",
    request(endpoint: string, query: string, _count: number) {
      const url = new URL(endpoint);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      return { url: url.href };
    },
    results(payload: unknown, count: number) {
      const rows = asOptionalObjectRecord(payload)?.results;
      return (Array.isArray(rows) ? rows : [])
        .filter((entry): entry is Record<string, unknown> & { title: string; url: string } => {
          const row = asOptionalObjectRecord(entry);
          return typeof row?.url === "string" && typeof row.title === "string";
        })
        .slice(0, count)
        .map((entry) => ({
          title: wrapWebContent(entry.title, "web_search"),
          url: entry.url,
          snippet: wrapped(string(entry.content)),
          siteName: resolveSiteName(entry.url) || undefined,
          img_src: string(entry.img_src) || undefined,
        }));
    },
  },
} as const;

// The direct plugin and proxy consumer share the native result formatter.
// Authentication, cache ownership and response admission remain caller-owned.
function readDeepSeekSearchResults(payload: unknown, count: number) {
  const data = asNonArrayRecord(payload);
  if (!Array.isArray(data.results)) {
    throw new Error("DeepSeek API error: malformed JSON response");
  }
  let omittedResults = false;
  const results = data.results.slice(0, count).flatMap((entry) => {
    const result = asNonArrayRecord(entry);
    const url = normalizeOptionalString(result.url);
    const parsed = url && url.length <= 2_048 ? URL.parse(url) : null;
    if (!parsed || !["http:", "https:"].includes(parsed.protocol) || parsed.href.length > 2_048) {
      omittedResults = true;
      return [];
    }
    return [
      {
        title: normalizeOptionalString(result.title) ?? "",
        url: parsed.href,
        snippet: normalizeOptionalString(result.summary) ?? normalizeOptionalString(result.snippet),
        published: normalizeOptionalString(result.date),
        siteName: normalizeOptionalString(result.site_name),
      },
    ];
  });
  return { results, omittedResults };
}
