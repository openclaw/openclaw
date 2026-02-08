import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions/paths.js";
// (no config dependency)
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { readStoredToolResultText } from "../tool-result-store.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const ToolResultGetSchema = Type.Object({
  ref: Type.String({ description: "Tool result ref string emitted by externalized tool results." }),
  offsetChars: Type.Optional(Type.Number({ minimum: 0 })),
  maxChars: Type.Optional(Type.Number({ minimum: 1 })),
});

const DEFAULT_MAX_CHARS = 4000;
const HARD_MAX_CHARS = 20_000;

function clampMaxChars(v: number | undefined): number {
  const raw = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : DEFAULT_MAX_CHARS;
  return Math.max(1, Math.min(HARD_MAX_CHARS, raw));
}

export function createToolResultGetTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Tool Result Get",
    name: "tool_result_get",
    description:
      "Fetch full/sliced content for a tool result that was externalized to save context tokens.",
    parameters: ToolResultGetSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const ref = readStringParam(params, "ref", { required: true });
      const offsetChars = readNumberParam(params, "offsetChars", { integer: true });
      const maxChars = clampMaxChars(readNumberParam(params, "maxChars", { integer: true }));

      // config not required
      const agentId = resolveAgentIdFromSessionKey(opts?.agentSessionKey);
      const sessionDir = resolveSessionTranscriptsDirForAgent(agentId);

      const result = readStoredToolResultText({ sessionDir, ref });
      if (!result.ok) {
        return jsonResult({ status: "not_found", error: result.error });
      }

      const start =
        typeof offsetChars === "number" && Number.isFinite(offsetChars) && offsetChars > 0
          ? Math.floor(offsetChars)
          : 0;
      const text = result.text;
      const slice = text.slice(start, Math.min(text.length, start + maxChars));

      return jsonResult({
        status: "ok",
        ref,
        offsetChars: start,
        returnedChars: slice.length,
        totalChars: text.length,
        text: slice,
      });
    },
  };
}
