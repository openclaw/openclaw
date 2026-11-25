import { Type } from "typebox";
import { captureExecRequestOwners } from "../../infra/exec-request-context.js";
import { resolveReplyRunForCurrentSessionId } from "../../sessions/session-controller.identity.js";
import { findSessionControllerOperationByRunId } from "../../sessions/session-controller.queries.js";
import { resolveAgentWorkspaceDir } from "../agent-scope.js";
import type { SandboxContext } from "../sandbox/types.js";
import { stringEnum } from "../schema/string-enum.js";
import { PROJECT_MOVE_HANDOFF_NAME } from "../sessions-yield-context.js";
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
  "Use list to see available registered projects. Use move with a listed projectId to resume this conversation in the project's managed checkout on a new turn. " +
  "Pass checkout to copy the current commit and unsaved changes from a project clone in the workspace. Otherwise start from the project's default branch. " +
  "Original files and links stay in place. Move only once. Finish or stop background exec, unfinished children, open terminals, and other runs before moving.";

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
    execute: async (toolCallId, rawArgs, signal) => {
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
      if (input.action === "list") {
        const { listSessionProjects } =
          await import("../../gateway/session-project-move-policy.js");
        return jsonResult({
          projects: await listSessionProjects(context.getRuntimeConfig(), currentRequester()),
        });
      }
      const { projectId } = input;
      const { sessionId } = options;
      if (!projectId || !sessionId) {
        throw new ToolInputError("move requires a projectId from list.");
      }
      const initialSandbox = options.sandbox;
      if (initialSandbox?.enabled) {
        const { describeProjectMoveSandboxBackend } =
          await import("../../gateway/session-project-move-policy.js");
        const reason = describeProjectMoveSandboxBackend(initialSandbox.backendId);
        if (reason) {
          throw new ToolInputError(reason);
        }
      }
      const carrySandbox =
        input.checkout && initialSandbox?.enabled
          ? {
              agentId: initialSandbox.agentId,
              sessionKey: initialSandbox.sessionKey,
              agentWorkspaceDir: initialSandbox.agentWorkspaceDir,
              workspaceDir: initialSandbox.workspaceDir,
              backendId: initialSandbox.backendId,
              containerWorkdir: initialSandbox.containerWorkdir,
            }
          : undefined;
      const session = {
        agentId: caller.agentId,
        sessionKey: caller.sessionKey,
      };
      const { moveSessionIntoProject } = await import("../../gateway/session-project-move.js");
      const { handoffSessionTool } = await import("./session-tool-handoff.js");
      return handoffSessionTool({
        name: PROJECT_MOVE_HANDOFF_NAME,
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
        run: ({ assertCurrent, signal: handoffSignal }) => {
          const requester = currentRequester();
          return moveSessionIntoProject({
            context,
            session,
            carrySource: carrySandbox
              ? async ({ assertCurrent: assertCarryCurrent, skillsSnapshot }) => {
                  // The initiating turn has settled. Acquire the same workspace
                  // under the handoff's authority, for the duration of the move.
                  const { resolveSandboxContext } = await import("../sandbox/context.js");
                  const sandbox = await resolveSandboxContext({
                    config: context.getRuntimeConfig(),
                    agentId: carrySandbox.agentId,
                    sessionKey: carrySandbox.sessionKey,
                    workspaceDir: carrySandbox.agentWorkspaceDir,
                    skillsSnapshot,
                    assertCurrent: assertCarryCurrent,
                    abortSignal: handoffSignal,
                  });
                  if (
                    !sandbox?.enabled ||
                    !sandbox.backend ||
                    sandbox.backendId !== carrySandbox.backendId ||
                    sandbox.workspaceDir !== carrySandbox.workspaceDir ||
                    sandbox.containerWorkdir !== carrySandbox.containerWorkdir
                  ) {
                    sandbox?.[Symbol.dispose]?.();
                    throw new Error(
                      "This conversation's sandbox checkout is unavailable; nothing was moved.",
                    );
                  }
                  return {
                    source: { kind: "sandbox", sandbox },
                    [Symbol.dispose]: () => sandbox[Symbol.dispose]?.(),
                  };
                }
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
        },
        formatResult: (result) => {
          const receipt = JSON.stringify(result);
          if (result.status !== "moved") {
            return receipt;
          }
          return (
            "Moved this conversation from the default workspace into the selected project. " +
            "Use the available tools now to finish any remaining instructions from the user's request in the new checkout before replying. " +
            "In the final reply, confirm which project this conversation moved into and report any results. Mention the branch only if useful.\n" +
            receipt
          );
        },
        completedToolCall: (result) =>
          result.status === "moved"
            ? { id: toolCallId, result: JSON.stringify(result) }
            : undefined,
      });
    },
  };
}
