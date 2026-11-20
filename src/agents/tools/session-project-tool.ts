import { Type } from "typebox";
import { ADMIN_SCOPE } from "../../gateway/operator-scopes.js";
import { captureExecRequestOwners } from "../../infra/exec-request-context.js";
import { resolveReplyRunForCurrentSessionId } from "../../sessions/session-controller.identity.js";
import { findSessionControllerOperationByRunId } from "../../sessions/session-controller.queries.js";
import { resolveAgentWorkspaceDir } from "../agent-scope.js";
import type { SandboxContext } from "../sandbox/types.js";
import { stringEnum } from "../schema/string-enum.js";
import { ToolInputError } from "../tool-input-error.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import {
  getGatewayToolCallerIdentity,
  resolveGatewayToolOperatorSelection,
} from "./gateway-caller-context.js";
import { getInProcessGatewayToolContext } from "./in-process-gateway.js";
import type { SessionsYieldCallback } from "./sessions-yield-tool.js";

const DESCRIPTION =
  "Move this conversation into a registered project, so its work happens in a managed checkout of that repository on its own branch and can be published as a pull request with github_publish. " +
  "list: the projects you may use. move: send a projectId from list; this turn ends, the project opens as it does for a session created in it, and the conversation resumes here in its new checkout. " +
  "Files from before the move stay in the original workspace, where earlier message links still open them. " +
  "When you already cloned this project into a folder of your workspace and worked there, pass that folder as checkout: its current commit and unsaved changes start the new checkout. Without checkout the new checkout starts from the project's default branch. " +
  "A conversation moves only once: when it already has a project or workspace, start a new session in the project instead (sessions_spawn with visible=true and projectId). " +
  "Running background exec, unfinished children, an open terminal or another run of this conversation refuse the move with nothing moved; finish or stop them first.";

/** The operator driving this run; owner and channel runs have none. */
function currentRequester() {
  const authority = resolveGatewayToolOperatorSelection().operatorAuthority;
  return authority ? { profileId: authority.profileId, scopes: authority.scopes } : undefined;
}

export function createSessionProjectTool(options: {
  sandbox?: SandboxContext | null;
  sessionId?: string;
  runId?: string;
  onYield?: SessionsYieldCallback;
  senderIsOwner?: boolean;
}): AnyAgentTool {
  let operation = options.runId ? findSessionControllerOperationByRunId(options.runId) : undefined;
  if (options.runId === undefined && options.sessionId) {
    const current = resolveReplyRunForCurrentSessionId(options.sessionId);
    operation = current.kind === "one" ? current.operation : undefined;
  }
  const requestOwners = captureExecRequestOwners(options);
  return {
    label: "Session Project",
    name: "session_project",
    // The move yields this turn, which a Code Mode exec cannot carry.
    async: false,
    catalogMode: "direct-only",
    description: DESCRIPTION,
    parameters: Type.Object(
      {
        action: stringEnum(["list", "move"]),
        projectId: Type.Optional(Type.String({ minLength: 1 })),
        checkout: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, rawArgs, signal) => {
      // SAFETY: the tool runtime validates rawArgs against the closed schema above.
      const input = rawArgs as { action: "list" | "move"; projectId?: string; checkout?: string };
      const caller = getGatewayToolCallerIdentity();
      const context = getInProcessGatewayToolContext();
      if (!caller?.agentId || !caller.sessionKey || !context) {
        throw new ToolInputError("session_project requires the current Gateway conversation.");
      }
      // Channel runs without a signed-in operator keep project source to the owner.
      if (!options.senderIsOwner && !currentRequester()) {
        throw new ToolInputError("Only the owner can move this conversation into a project.");
      }
      const { listSessionProjects, moveSessionIntoProject, openMovedSession } =
        await import("../../gateway/session-project-move.js");
      if (input.action === "list") {
        return jsonResult({ projects: await listSessionProjects(context, currentRequester()) });
      }
      const { projectId } = input;
      const { sessionId } = options;
      if (!projectId || !sessionId) {
        throw new ToolInputError("move requires a projectId from list.");
      }
      const sandbox = options.sandbox?.enabled ? options.sandbox : undefined;
      const session = {
        agentId: caller.agentId,
        sessionKey: caller.sessionKey,
      };
      const { handoffSessionTool } = await import("./session-tool-handoff.js");
      return handoffSessionTool({
        name: "Project move",
        sessionId,
        runId: options.runId,
        operation,
        requestOwners,
        onYield: options.onYield,
        signal,
        senderIsOwner: options.senderIsOwner,
        // The move runs after this turn ends, still for the person who asked for it.
        retainRequester: true,
        fenceSuccessors: true,
        run: async ({ assertCurrent, signal: handoffSignal }) => {
          const requester = currentRequester();
          const moved = await moveSessionIntoProject({
            context,
            session,
            carrySource: sandbox
              ? { kind: "sandbox", sandbox }
              : {
                  kind: "host",
                  workspaceDir: resolveAgentWorkspaceDir(
                    context.getRuntimeConfig(),
                    session.agentId,
                  ),
                },
            projectId,
            ...(input.checkout ? { checkout: input.checkout } : {}),
            requester,
            assertCurrent,
            signal: handoffSignal,
          });
          // The resumed turn is a session event, which never prepares a pending checkout.
          const branch = await openMovedSession({
            context,
            session,
            runId: options.runId ?? `session-project:${sessionId}`,
            runSetupScript: !requester || requester.scopes.includes(ADMIN_SCOPE),
            assertCurrent,
            signal: handoffSignal,
          });
          return { ...moved, status: "moved", ...(branch ? { branch } : {}) };
        },
        formatResult: (result) => JSON.stringify(result),
      });
    },
  };
}
