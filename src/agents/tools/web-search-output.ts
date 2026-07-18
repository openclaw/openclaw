/**
 * Normalized `web_search` output contract.
 *
 * Every bundled or external provider payload is normalized at the core tool
 * boundary into one of four closed branches (error / results / answer / raw).
 * The boundary owns the untrusted-content envelope: provider prose is
 * re-wrapped here unconditionally, so no provider-controlled metadata can
 * spoof the trust marker and transport-specific extras never reach the model.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Static } from "typebox";
import { Type } from "typebox";
import { wrapWebContent } from "../../security/external-content.js";

const WebSearchExternalContentSchema = Type.Object(
  {
    untrusted: Type.Literal(true),
    source: Type.Literal("web_search"),
    wrapped: Type.Literal(true),
    provider: Type.String(),
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
  // Compatibility branch: external SDK providers may return payloads that fit
  // none of the branches above. Their data passes through verbatim, as shipped
  // behavior always did, instead of being converted into a synthetic error.
  Type.Object(
    {
      kind: Type.Literal("raw"),
      provider: Type.String(),
      data: Type.Unknown(),
    },
    { additionalProperties: false },
  ),
]);

export type WebSearchOutput = Static<typeof WebSearchOutputSchema>;

// Matches well-formed envelope framing lines from wrapExternalContent. Provider
// text is stripped of any existing (or forged) envelopes before the boundary
// applies its own, so output carries exactly one provable envelope per field.
const ENVELOPE_LINE_RE =
  /^[ \t]*<<<(?:END_)?EXTERNAL_UNTRUSTED_CONTENT id="[0-9a-f]+">>>[ \t]*$\n?|^Source: [^\n]*\n---\n/gmu;

function unwrapEnvelopes(value: string): string {
  return value.replace(ENVELOPE_LINE_RE, "").trim();
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

const ERROR_CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/u;
// Purely structural date charset; free-form dates could smuggle instructions.
const PUBLISHED_RE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.+Z-]{0,20})?$/u;

function wrapProse(value: string): string {
  const inner = unwrapEnvelopes(value);
  return inner.length === 0 ? "" : wrapWebContent(inner, "web_search");
}

function externalContentStamp(provider: string): WebSearchExternalContent {
  return { untrusted: true, source: "web_search", wrapped: true, provider };
}

function normalizeCitations(value: unknown): Array<{ url: string; title?: string }> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  // A citation url must actually parse as http(s); free text in a url slot
  // would bypass the untrusted-content envelope.
  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      return isHttpUrl(entry) ? [{ url: entry }] : [];
    }
    if (!isRecord(entry) || typeof entry.url !== "string" || !isHttpUrl(entry.url)) {
      return [];
    }
    return [
      {
        url: entry.url,
        ...(typeof entry.title === "string" ? { title: wrapProse(entry.title) } : {}),
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
  // The model's own request query is authoritative; provider echoes are
  // untrusted text and add nothing the model does not already know.
  const query = params.query;

  // A declared error always wins: providers never mix an error key into
  // success payloads, so treating it as failure first prevents an error plus
  // empty results from masquerading as a successful search.
  if (Object.hasOwn(result, "error")) {
    // Error branches carry no externalContent marker, so nothing free-form may
    // pass unwrapped: codes are charset-gated, docs must parse as http(s), and
    // the human-readable message gets the untrusted envelope.
    const rawError = typeof result.error === "string" ? result.error : "provider_error";
    const error = ERROR_CODE_RE.test(rawError) ? rawError : "provider_error";
    const rawMessage = typeof result.message === "string" ? result.message : rawError;
    return {
      kind: "error",
      provider,
      error,
      message: wrapProse(rawMessage),
      ...(typeof result.docs === "string" && isHttpUrl(result.docs) ? { docs: result.docs } : {}),
    };
  }

  // A results branch requires conforming rows; anything else is preserved as
  // raw so nonstandard external payloads are never silently gutted.
  const rows = Array.isArray(result.results) ? result.results : undefined;
  const conformingRows = rows?.every(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) &&
      typeof entry.title === "string" &&
      typeof entry.url === "string" &&
      isHttpUrl(entry.url),
  );
  if (rows && conformingRows) {
    const results = rows.map((row) => {
      const snippet =
        typeof row.snippet === "string"
          ? row.snippet
          : typeof row.description === "string"
            ? row.description
            : Array.isArray(row.snippets)
              ? row.snippets.find((value): value is string => typeof value === "string")
              : undefined;
      const published =
        typeof row.published === "string" && PUBLISHED_RE.test(row.published)
          ? row.published
          : undefined;
      return {
        title: wrapProse(row.title as string),
        url: row.url as string,
        ...(snippet !== undefined ? { snippet: wrapProse(snippet) } : {}),
        ...(published !== undefined ? { published } : {}),
        ...(typeof row.siteName === "string" ? { siteName: wrapProse(row.siteName) } : {}),
      };
    });
    return {
      kind: "results",
      provider,
      query,
      count: readFiniteNumber(result.count) ?? results.length,
      ...(tookMs !== undefined ? { tookMs } : {}),
      results,
      externalContent: externalContentStamp(provider),
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
      content: wrapProse(result.content),
      ...(citations !== undefined ? { citations } : {}),
      externalContent: externalContentStamp(provider),
      ...(cached ? { cached } : {}),
    };
  }

  return { kind: "raw", provider, data: result };
}
