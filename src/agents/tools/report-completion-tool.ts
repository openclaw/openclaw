import { Type } from "@sinclair/typebox";
import {
  COMPLETION_STATUSES,
  CONFIDENCE_LEVELS,
  type CompletionArtifact,
  type CompletionReport,
  type CompletionConfidence,
  type CompletionStatus,
} from "../completion-report-parser.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { jsonResult, readStringArrayParam, readStringParam, type AnyAgentTool } from "./common.js";

const ReportCompletionToolSchema = Type.Object({
  status: optionalStringEnum(COMPLETION_STATUSES),
  confidence: optionalStringEnum(CONFIDENCE_LEVELS),
  artifacts: Type.Optional(
    Type.Array(
      Type.Object({
        path: Type.String({ minLength: 1 }),
        description: Type.Optional(Type.String()),
      }),
      { minItems: 1 },
    ),
  ),
  blockers: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
  summary: Type.String({ minLength: 1 }),
  warnings: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
});

function normalizeOptionalStatus(value: unknown): CompletionStatus | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return COMPLETION_STATUSES.includes(normalized as CompletionStatus)
    ? (normalized as CompletionStatus)
    : undefined;
}

function normalizeOptionalConfidence(value: unknown): CompletionReport["confidence"] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return CONFIDENCE_LEVELS.includes(normalized as CompletionConfidence)
    ? (normalized as CompletionConfidence)
    : undefined;
}

function normalizeArtifacts(raw: unknown): CompletionArtifact[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const normalized = raw
    .map((item) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }
      const path = typeof item.path === "string" ? item.path.trim() : "";
      if (!path) {
        return undefined;
      }
      const descriptionRaw = item.description;
      const description =
        typeof descriptionRaw === "string" && descriptionRaw.trim().length > 0
          ? descriptionRaw.trim()
          : undefined;
      const artifact: CompletionArtifact = description ? { path, description } : { path };
      return artifact;
    })
    .filter((entry): entry is CompletionArtifact => entry !== undefined);

  return normalized.length > 0 ? normalized : undefined;
}

export function createReportCompletionTool(): AnyAgentTool {
  return {
    label: "Report Completion",
    name: "report_completion",
    description:
      "Report completion details, artifacts, and confidence after finishing a subagent task.",
    parameters: ReportCompletionToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;

      const status = normalizeOptionalStatus(readStringParam(params, "status"));
      const confidence = normalizeOptionalConfidence(readStringParam(params, "confidence"));
      const summary = readStringParam(params, "summary", {
        required: true,
        label: "summary",
      });

      const blockers = readStringArrayParam(params, "blockers");
      const warnings = readStringArrayParam(params, "warnings");
      const artifacts = normalizeArtifacts(params.artifacts);

      const payload: CompletionReport = {
        summary,
      };

      if (status) {
        payload.status = status;
      }
      if (confidence) {
        payload.confidence = confidence;
      }
      if (artifacts) {
        payload.artifacts = artifacts;
      }
      if (blockers?.length) {
        payload.blockers = blockers;
      }
      if (warnings?.length) {
        payload.warnings = warnings;
      }

      return jsonResult(payload);
    },
  };
}
