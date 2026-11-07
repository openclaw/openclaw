import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { jsonResult, readToolStringParam, ToolInputError, type AnyAgentTool } from "./common.js";
import { SessionsCreateToolSchema } from "./sessions-create-tool-schema.js";
import type { SessionsSpawnToolOptions } from "./sessions-spawn-options.js";
import { createSessionsSpawnTool } from "./sessions-spawn-tool.js";

/**
 * Independent sessions are created by the visible-spawn owner, so the caller
 * attribution, admission, and containment inheritance match
 * sessions_spawn(visible: true). Only supervision differs: no run registration,
 * completion event, or yield expectation.
 */
export function createSessionsCreateTool(opts?: SessionsSpawnToolOptions): AnyAgentTool {
  const spawn = createSessionsSpawnTool({ ...opts, independent: true });
  return {
    label: "New session",
    name: "sessions_create",
    description:
      "Use only when the user explicitly requests a new independent session or task. Ordinary helper delegation and unrequested follow-ups do not authorize independent creation. Create a normal independent persistent visible session, optionally starting work with message. Omit message for an idle session. Inherits this conversation's sandbox, tool, and permission limits; not a supervised child or transcript fork. Returns sessionKey, sessionId, and runStarted, plus runId or runError when available. Creation and initial-run acceptance are separate; a startup failure leaves the session available. No child completion event or yield expectation.",
    parameters: SessionsCreateToolSchema,
    execute: async (toolCallId, rawArgs, signal) => {
      const params = asOptionalRecord(rawArgs);
      if (!params) {
        throw new ToolInputError("sessions_create requires an object");
      }
      const unknown = Object.keys(params).filter(
        (key) => !Object.hasOwn(SessionsCreateToolSchema.properties, key),
      );
      if (unknown.length) {
        throw new ToolInputError("sessions_create does not accept: " + unknown.join(", "));
      }
      // Spawn treats non-string destination values as absent; reject them like sessions.create.
      for (const key of ["label", "agentId", "cwd", "group", "model"]) {
        if (params[key] !== undefined) {
          readToolStringParam(params, key, { required: true });
        }
      }
      const { message: _message, ...destination } = params;
      const message =
        params.message === undefined
          ? undefined
          : readToolStringParam(params, "message", { required: true, trim: false });
      if (message !== undefined && !message.trim()) {
        throw new ToolInputError("message must not be blank");
      }
      const result = await spawn.execute(
        toolCallId,
        { ...destination, visible: true, ...(message !== undefined ? { task: message } : {}) },
        signal,
      );
      const created = asOptionalRecord(result.details);
      if (created?.status !== "created") {
        return result;
      }
      return jsonResult({
        sessionKey: created.childSessionKey,
        sessionId: created.sessionId,
        runStarted: created.runStarted,
        ...(created.runId ? { runId: created.runId } : {}),
        ...(message !== undefined && !created.runStarted ? { runError: created.runError } : {}),
      });
    },
  };
}
