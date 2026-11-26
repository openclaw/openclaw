import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readAdmittedUnlinkedChannelRequester } from "../../auto-reply/requester-profile.js";
import { jsonResult, readToolStringParam, ToolInputError, type AnyAgentTool } from "./common.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
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
  const createStandalone = createSessionsSpawnTool({
    ...opts,
    independent: "standalone",
  });
  return {
    label: "New session",
    name: "sessions_create",
    description:
      "Create a persistent visible session only for user-requested independent sessions, tasks, or standalone recurring automations. Ordinary helper delegation and unrequested follow-ups do not authorize creation. For standalone recurring automation, create an idle named session, then schedule against its returned sessionKey. Omit message for idle; supply it to start work. Set standalone=true when the user asks for no parent; this mode supports a registered project and a fresh worktree. Omit worktreeBaseRef for the remote default branch. Inherits this conversation's sandbox, tool, and permission limits; not a supervised child or transcript fork. Returns sessionKey, sessionId, runStarted and, when available, runId or runError. Startup failure leaves the session available. No child completion event or yield expectation.",
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
      for (const key of [
        "label",
        "agentId",
        "cwd",
        "group",
        "model",
        "projectId",
        "worktreeBaseRef",
      ]) {
        if (params[key] !== undefined) {
          readToolStringParam(params, key, { required: true });
        }
      }
      for (const key of ["standalone", "worktree"]) {
        if (params[key] !== undefined && typeof params[key] !== "boolean") {
          throw new ToolInputError(`${key} must be a boolean`);
        }
      }
      if (
        params.standalone !== true &&
        (params.projectId !== undefined ||
          params.worktree !== undefined ||
          params.worktreeBaseRef !== undefined)
      ) {
        throw new ToolInputError("Project and worktree options require standalone=true.");
      }
      if (params.worktreeBaseRef !== undefined && params.worktree !== true) {
        throw new ToolInputError("worktreeBaseRef requires worktree=true.");
      }
      if (params.projectId !== undefined && params.cwd !== undefined) {
        throw new ToolInputError("Choose either projectId or cwd, not both.");
      }
      const { message: _message, standalone, ...destination } = params;
      // An unlinked source has no person to select. Ignore only this stray model selector,
      // never a linked participant refusal or a missing/revoked requester context.
      const caller = getGatewayToolCallerIdentity();
      const unlinkedRequester = readAdmittedUnlinkedChannelRequester(
        caller?.operationalRunInstance,
      );
      if (
        readToolStringParam(params, "user") !== undefined &&
        !caller?.operatorAuthority &&
        unlinkedRequester
      ) {
        unlinkedRequester();
        delete destination.user;
      }
      const message =
        params.message === undefined
          ? undefined
          : readToolStringParam(params, "message", { required: true, trim: false });
      if (message !== undefined && !message.trim()) {
        throw new ToolInputError("message must not be blank");
      }
      const create = standalone === true ? createStandalone : spawn;
      const result = await create.execute(
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
