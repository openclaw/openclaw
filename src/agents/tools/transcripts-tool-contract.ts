import { Type } from "typebox";
import type { CoreToolDeclaration } from "../agent-tool-metadata.js";

const TranscriptsSchema = Type.Object(
  {
    action: Type.String({
      description: "start, stop, status, import, summarize, list, or show.",
    }),
    sessionId: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Raw ID for start/import. Legacy stop/summarize/show handle; prefer selector for an exact capture. Cannot be combined with selector.",
      }),
    ),
    selector: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Exact dated capture selector returned by start/import/status. Only for stop/summarize/show; supply this or sessionId, never both. No raw-ID fallback.",
      }),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
    title: Type.Optional(Type.String({ minLength: 1 })),
    providerId: Type.Optional(Type.String({ minLength: 1 })),
    accountId: Type.Optional(Type.String({ minLength: 1 })),
    guildId: Type.Optional(Type.String({ minLength: 1 })),
    channelId: Type.Optional(Type.String({ minLength: 1 })),
    meetingUrl: Type.Optional(Type.String({ minLength: 1 })),
    transcript: Type.Optional(Type.String({ minLength: 1 })),
    speakerLabel: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const TRANSCRIPTS_TOOL_DECLARATION: CoreToolDeclaration = {
  name: "transcripts",
  description:
    "Start, stop, import, summarize, or inspect meeting transcript captures; list past meetings and read their notes.",
  parameters: TranscriptsSchema,
};
