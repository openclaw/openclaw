import { isRecord } from "@openclaw/normalization-core/record-coerce";
/**
 * Normalized `web_search` output contract.
 *
 * Every bundled or external provider payload is normalized at the core tool
 * boundary into one of three closed branches (error / results / answer), so
 * transport-specific extras never reach the model and the declared contract
 * cannot drift per provider.
 */
import type { Static } from "typebox";
import { Type } from "typebox";

const WebSearchExternalContentSchema = Type.Object(
  {
    untrusted: Type.Literal(true),
    source: Type.Literal("web_search"),
    wrapped: Type.Literal(true),
    provider: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
type WebSearchExternalContent = Static<typeof WebSearchExternalContentSchema>;

const WebSearchResultSchema = Type.Object(
  {
    title: Type.String(),
    url: Type.String(),
    snippet: Type.Optional(Type.String()),
    published: Type.Optional(Type.String()),
    siteName: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const WebSearchCitationSchema = Type.Object(
  {
    url: Type.String(),
    title: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const WebSearchOutputSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("error"),
      provider: Type.String(),
      error: Type.String(),
      message: Type.String(),
      docs: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("results"),
      provider: Type.String(),
      query: Type.String(),
      queryTerms: Type.Optional(Type.Array(Type.String())),
      count: Type.Number(),
      tookMs: Type.Optional(Type.Number()),
      results: Type.Array(WebSearchResultSchema),
      externalContent: WebSearchExternalContentSchema,
      cached: Type.Optional(Type.Literal(true)),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("answer"),
      provider: Type.String(),
      query: Type.String(),
      tookMs: Type.Optional(Type.Number()),
      content: Type.String(),
      citations: Type.Optional(Type.Array(WebSearchCitationSchema)),
      externalContent: WebSearchExternalContentSchema,
      cached: Type.Optional(Type.Literal(true)),
    },
    { additionalProperties: false },
  ),
]);

export type WebSearchOutput = Static<typeof WebSearchOutputSchema>;

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeExternalContent(raw: Record<string, unknown>): WebSearchExternalContent {
  const externalContent = isRecord(raw.externalContent) ? raw.externalContent : undefined;
  return {
    untrusted: true,
    source: "web_search",
    wrapped: true,
    ...(typeof externalContent?.provider === "string"
      ? { provider: externalContent.provider }
      : {}),
  };
}

function normalizeCitations(value: unknown): Array<{ url: string; title?: string }> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      return [{ url: entry }];
    }
    if (!isRecord(entry) || typeof entry.url !== "string") {
      return [];
    }
    return [
      {
        url: entry.url,
        ...(typeof entry.title === "string" ? { title: entry.title } : {}),
      },
    ];
  });
}

/** Normalizes every bundled or external provider payload at the core tool boundary. */
export function normalizeWebSearchOutput(params: {
  result: Record<string, unknown>;
  provider: string;
  query: string;
}): WebSearchOutput {
  const { result, provider } = params;
  const tookMs = readFiniteNumber(result.tookMs);
  const cached = result.cached === true ? true : undefined;
  const queryTerms = Array.isArray(result.searchQueries)
    ? result.searchQueries.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const query =
    queryTerms !== undefined
      ? (queryTerms[0] ?? params.query)
      : typeof result.query === "string"
        ? result.query
        : params.query;

  if (Array.isArray(result.results)) {
    const results = result.results.map((entry) => {
      const row = isRecord(entry) ? entry : {};
      const snippet =
        typeof row.snippet === "string"
          ? row.snippet
          : typeof row.description === "string"
            ? row.description
            : Array.isArray(row.snippets)
              ? row.snippets.find((value): value is string => typeof value === "string")
              : undefined;
      return {
        title: typeof row.title === "string" ? row.title : "",
        url: typeof row.url === "string" ? row.url : "",
        ...(snippet !== undefined ? { snippet } : {}),
        ...(typeof row.published === "string" ? { published: row.published } : {}),
        ...(typeof row.siteName === "string" ? { siteName: row.siteName } : {}),
      };
    });
    return {
      kind: "results",
      provider,
      query,
      ...(queryTerms !== undefined ? { queryTerms } : {}),
      count: readFiniteNumber(result.count) ?? results.length,
      ...(tookMs !== undefined ? { tookMs } : {}),
      results,
      externalContent: normalizeExternalContent(result),
      ...(cached ? { cached } : {}),
    };
  }

  if (typeof result.content === "string") {
    const citations = normalizeCitations(result.citations);
    return {
      kind: "answer",
      provider,
      query,
      ...(tookMs !== undefined ? { tookMs } : {}),
      content: result.content,
      ...(citations !== undefined ? { citations } : {}),
      externalContent: normalizeExternalContent(result),
      ...(cached ? { cached } : {}),
    };
  }

  if (Object.hasOwn(result, "error")) {
    const error = typeof result.error === "string" ? result.error : "provider_error";
    return {
      kind: "error",
      provider,
      error,
      message: typeof result.message === "string" ? result.message : error,
      ...(typeof result.docs === "string" ? { docs: result.docs } : {}),
    };
  }

  return {
    kind: "error",
    provider,
    error: "unrecognized_provider_result",
    message: `Web search provider "${provider}" returned an unrecognized result.`,
  };
}
