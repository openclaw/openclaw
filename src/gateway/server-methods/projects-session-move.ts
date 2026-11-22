import {
  ErrorCodes,
  errorShape,
  validateProjectsMoveSessionOptionsParams,
  validateProjectsMoveSessionParams,
  type ProjectsMoveSessionOptionsResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveSandboxContext } from "../../agents/sandbox/context.js";
import { isUnboundProjectSession } from "../../config/sessions/session-project-eligibility.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { parseProjectGitUrl } from "../../projects/project-git-url.js";
import type { GatewaySessionAccessAuthority } from "../session-access-authority.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import {
  describeSessionProjectSandboxBlocker,
  listSessionProjects,
} from "../session-project-move-policy.js";
import { moveSessionIntoProject } from "../session-project-move.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "../session-utils-store-worker.js";
import { listCarryCheckouts, type CarrySource } from "../session-workspace-carry.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayClient, GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

type MoveTarget = { access: GatewaySessionAccessAuthority; assertCurrent: () => void };

function requester(client: GatewayClient | null) {
  return client
    ? {
        profileId: client.authenticatedUserProfile?.profileId,
        scopes: [...(client.connect.scopes ?? [])],
      }
    : undefined;
}

/**
 * Where an unbound conversation's files live: its sandbox, or the agent workspace on
 * the host for a conversation without one. A bound conversation gets the reason instead.
 */
async function resolveCarrySource(
  context: GatewayRequestContext,
  target: MoveTarget,
  signal?: AbortSignal,
): Promise<{ source: CarrySource; [Symbol.dispose]: () => void } | { reason: string }> {
  const cfg = context.getRuntimeConfig();
  const { agentId, sessionKey } = target.access.target;
  const { entry } = await loadGatewaySessionEntryReadOnlyInWorker({
    cfg,
    agentId,
    key: sessionKey,
    projection: "full",
  });
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  if (!entry || !isUnboundProjectSession(entry, agentId, workspaceDir)) {
    return { reason: "Only a conversation in the general workspace can move into a project." };
  }
  const reason = describeSessionProjectSandboxBlocker(cfg, { agentId, sessionKey }, entry);
  if (reason) {
    return { reason };
  }
  const sandbox = await resolveSandboxContext({
    config: cfg,
    agentId,
    sessionKey,
    workspaceDir: entry?.sessionRoot ?? workspaceDir,
    skillsSnapshot: entry?.skillsSnapshot,
    assertCurrent: target.assertCurrent,
    abortSignal: signal,
  });
  if (sandbox?.enabled && sandbox.backend) {
    return {
      source: { kind: "sandbox", sandbox },
      [Symbol.dispose]: () => sandbox[Symbol.dispose]?.(),
    };
  }
  sandbox?.[Symbol.dispose]?.();
  return { source: { kind: "host", workspaceDir }, [Symbol.dispose]: () => {} };
}

function moveTarget(
  access: GatewaySessionAccessAuthority | undefined,
  signal: AbortSignal | undefined,
): MoveTarget | undefined {
  return access
    ? {
        access,
        assertCurrent: () => {
          signal?.throwIfAborted();
          access.assertCurrent();
        },
      }
    : undefined;
}

const NO_ACCESS = errorShape(
  ErrorCodes.FORBIDDEN,
  "Moving a conversation into a project requires write access to it.",
);

export const projectsSessionMoveHandlers: GatewayRequestHandlers = {
  "projects.moveSessionOptions": defineValidatedGatewayHandler(
    "projects.moveSessionOptions",
    validateProjectsMoveSessionOptionsParams,
    async ({ respond, context, client, signal, sessionAccessAuthority }) => {
      const target = moveTarget(sessionAccessAuthority, signal);
      if (!target) {
        respond(false, undefined, NO_ACCESS);
        return;
      }
      const resolved = await resolveCarrySource(context, target, signal);
      if ("reason" in resolved) {
        respond(true, { available: false, reason: resolved.reason, projects: [] });
        return;
      }
      using carrySource = resolved;
      const [projects, checkouts] = await Promise.all([
        listSessionProjects(context.getRuntimeConfig(), requester(client)),
        listCarryCheckouts(carrySource.source, signal),
      ]);
      target.assertCurrent();
      const result: ProjectsMoveSessionOptionsResult = {
        available: true,
        projects: projects.slice(0, 200).map((project) => {
          const origin = project.originUrl && parseProjectGitUrl(project.originUrl)?.url;
          // Only checkouts of this project's repository can carry their work into it.
          return Object.assign(project, {
            checkouts: checkouts
              .filter(({ originUrl }) => origin && parseProjectGitUrl(originUrl)?.url === origin)
              .slice(0, 32)
              .map(({ path, commit, unsavedFiles }) => ({ path, commit, unsavedFiles })),
          });
        }),
      };
      respond(true, result);
    },
  ),
  "projects.moveSession": defineValidatedGatewayHandler(
    "projects.moveSession",
    validateProjectsMoveSessionParams,
    async (options) => {
      const { params, respond, context, client, signal, sessionAccessAuthority } = options;
      const target = moveTarget(sessionAccessAuthority, signal);
      if (!target) {
        respond(false, undefined, NO_ACCESS);
        return;
      }
      try {
        const resolved = await resolveCarrySource(context, target, signal);
        if ("reason" in resolved) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, resolved.reason));
          return;
        }
        using carrySource = resolved;
        const authority = readGatewayRequestMutationAuthority(options);
        const moved = await moveSessionIntoProject({
          context,
          session: target.access.target,
          carrySource: carrySource.source,
          projectId: params.projectId,
          ...(params.checkout ? { checkout: params.checkout } : {}),
          requester: requester(client),
          assertCurrent: () => {
            authority.assertCurrent();
            target.assertCurrent();
          },
          signal,
        });
        respond(true, moved);
      } catch (error) {
        if (error instanceof SessionMutationAuthorizationChangedError) {
          respond(false, undefined, error.error);
          return;
        }
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)),
        );
      }
    },
  ),
};
