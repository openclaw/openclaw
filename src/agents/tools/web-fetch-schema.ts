import { Type } from "typebox";
import { stringEnum } from "../schema/string-enum.js";

const EXTRACT_MODES = ["markdown", "text"] as const;

export const WebFetchSchema = Type.Object({
  url: Type.String({ description: "HTTP(S) URL." }),
  extractMode: Type.Optional(
    stringEnum(EXTRACT_MODES, {
      description: "Extract as markdown/text.",
      default: "markdown",
    }),
  ),
  maxChars: Type.Optional(
    Type.Integer({
      description: "Max chars returned; truncates.",
      minimum: 100,
    }),
  ),
});

export const WebFetchOutputSchema = Type.Object(
  {
    url: Type.String(),
    finalUrl: Type.String(),
    status: Type.Integer({ minimum: 0 }),
    contentType: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    extractMode: stringEnum(EXTRACT_MODES),
    extractor: Type.String(),
    externalContent: Type.Object(
      {
        untrusted: Type.Literal(true),
        source: Type.Literal("web_fetch"),
        wrapped: Type.Literal(true),
        provider: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    truncated: Type.Boolean(),
    length: Type.Integer({ minimum: 0 }),
    rawLength: Type.Integer({ minimum: 0 }),
    spill: Type.Optional(
      Type.Object(
        {
          path: Type.String(),
          chars: Type.Integer({ minimum: 0 }),
          truncated: Type.Optional(Type.Literal(true)),
        },
        { additionalProperties: false },
      ),
    ),
    fetchedAt: Type.String(),
    tookMs: Type.Integer({ minimum: 0 }),
    text: Type.String(),
    warning: Type.Optional(Type.String()),
    cached: Type.Optional(Type.Literal(true)),
    quality: Type.Optional(
      Type.Object(
        {
          mode: Type.Union([Type.Literal("shadow"), Type.Literal("apply")]),
          status: Type.Union([Type.Literal("evaluated"), Type.Literal("unavailable")]),
          probabilityUnusable: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
          suppressed: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
