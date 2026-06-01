import { Type } from "typebox";
import { appendSoulRule } from "../soul-auto-update.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, ToolInputError } from "./common.js";

export const SOUL_UPDATE_TOOL_NAME = "soul_update";

const SoulUpdateToolSchema = Type.Object(
  {
    rule: Type.String({ minLength: 1, maxLength: 280 }),
    evidence: Type.Optional(Type.String({ maxLength: 280 })),
    noop: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(params: Record<string, unknown>, key: string): string | undefined {
  const raw = params[key];
  return typeof raw === "string" ? raw : undefined;
}

function readBool(params: Record<string, unknown>, key: string): boolean | undefined {
  const raw = params[key];
  return typeof raw === "boolean" ? raw : undefined;
}

export function createSoulUpdateTool(opts: { workspaceDir: string }): AnyAgentTool {
  return {
    label: "Soul",
    name: SOUL_UPDATE_TOOL_NAME,
    displaySummary: "Append a durable preference/rule to SOUL.md.",
    description:
      "Append one durable preference, correction, or self-rule to the agent's SOUL.md under `## Auto-added`. " +
      "Call only when the user expressed something worth persisting across sessions. " +
      "Pass `noop: true` (no `rule`) when nothing in recent context warrants a new entry.",
    parameters: SoulUpdateToolSchema,
    execute: async (_toolCallId, args) => {
      if (!isRecord(args)) {
        throw new ToolInputError("soul_update arguments required");
      }
      if (readBool(args, "noop") === true) {
        return jsonResult({ status: "noop" });
      }
      const rule = readString(args, "rule");
      if (!rule || rule.trim().length === 0) {
        throw new ToolInputError("rule required (or pass noop=true)");
      }
      const evidence = readString(args, "evidence");
      const result = await appendSoulRule({
        workspaceDir: opts.workspaceDir,
        rule,
        evidence,
      });
      if (result.ok) {
        return jsonResult({
          status: "appended",
          rule: result.rule,
          sectionCreated: result.created,
          notice: `Added to SOUL.md: '${result.rule}'`,
        });
      }
      if (result.reason === "duplicate") {
        return jsonResult({ status: "duplicate", reason: "rule already present" });
      }
      throw new ToolInputError(
        result.detail ? `${result.reason}: ${result.detail}` : result.reason,
      );
    },
  };
}
