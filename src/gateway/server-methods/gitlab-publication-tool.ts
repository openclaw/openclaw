import { parseGitLabPublicationToolRequest } from "@openclaw/gateway-protocol/gitlab-publication";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/schema/error-codes.js";
import { capturePluginLifecycleAuthority } from "../../plugins/registry-lifecycle.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { prepareUserProfileRolePolicyAuthority } from "../../state/user-channel-identity-operations.js";
import { prepareGitHubPublicationSession } from "../github-publication-availability.js";
import {
  personalGitLabPublicationCredential,
  type GitLabPublicationCredential,
} from "../gitlab-personal-publication-identity.js";
import {
  confirmPersonalGitLabPublication,
  readGitLabPublicationPublisher,
  readPersonalGitLabPublicationStatus,
  requestPersonalGitLabPublication,
  readPersonalGitLabCheckoutTarget,
  preparePersonalGitLabPublicationProject,
  assertPersonalGitLabPublicationProjectAllowed,
} from "../gitlab-personal-publication.js";
import { consumeAcceptedPluginGatewayHandoffClaim } from "../plugin-tool-handoff-claim.js";
import { adoptUnboundPullRequestWorkspace } from "../session-pr-workspace-adoption.js";
import { resolveLocalWorkspaceOwner } from "../worker-environments/local-workspace-projection.js";
import {
  bindPersonalForgeSessionAction,
  retainPersonalForgePublicationSession,
} from "./github-personal-authorization.js";
import {
  currentPersonalForgeClient,
  type PersonalForgeAction,
} from "./personal-forge-authorization.js";
import { preparePersonalForgeToolAction } from "./personal-forge-tool-authorization.js";
import { respondError } from "./response.js";
import { prepareSessionCreateRequestedCwd } from "./session-create-root.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";

async function prepareHandoffRequester(options: GatewayRequestHandlerOptions) {
  const claim = consumeAcceptedPluginGatewayHandoffClaim(options, {
    pluginId: "gitlab",
    toolName: "gitlab_publish",
  });
  const authority = claim.operatorAuthority;
  if (!authority || options.client?.internal?.operatorRunAuthority?.source !== authority.source) {
    throw new Error("GitLab publication requires its admitted requesting user.");
  }
  const signal = AbortSignal.any([claim.signal, ...(options.signal ? [options.signal] : [])]);
  const assertSource = () => {
    signal.throwIfAborted();
    claim.assertCurrent();
    authority.assertCurrent();
    options.sessionMutationCommitGuard?.();
  };
  assertSource();
  const profile = await prepareUserProfileRolePolicyAuthority(authority.profileId);
  assertSource();
  if (!profile) {
    throw new Error("Your GitLab publication profile is unavailable; sign in again.");
  }
  const action: PersonalForgeAction = {
    owner: authority.profileId,
    signal,
    assertCurrent() {
      assertSource();
      if (!profile.isCurrent()) {
        throw new Error(
          "Your publication profile changed; retry from your current signed-in turn.",
        );
      }
      currentPersonalForgeClient(options, "operator.sessions.write", profile, "GitLab");
    },
  };
  action.assertCurrent();
  return { action, claim };
}

const handlePublication: GatewayRequestHandler = async (options) => {
  const input = parseGitLabPublicationToolRequest(options.params);
  const operation = input?.operation;
  if (
    !input ||
    !operation ||
    options.req.method !== `tools.gitlab.publication.${operation.action}`
  ) {
    respondError(
      options.respond,
      ErrorCodes.INVALID_REQUEST,
      "Invalid GitLab publication operation.",
    );
    return;
  }
  try {
    const service = options.context.gitlabOAuthService;
    if (!service) {
      throw new Error("GitLab is not configured. Ask an administrator to configure this server.");
    }
    if (operation.action === "status") {
      const registry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
      const record = registry?.plugins.find((plugin) => plugin.id === "gitlab");
      const pluginCurrent =
        registry &&
        record &&
        capturePluginLifecycleAuthority(registry, record, { scopedRuntime: true });
      if (options.client?.internal?.pluginRuntimeOwnerId !== "gitlab" || !pluginCurrent) {
        throw new Error("GitLab publication status requires its active gitlab_publish tool.");
      }
      const requesterSource = await preparePersonalForgeToolAction(
        options,
        "gitlab_publish",
        "operator.sessions.read",
        "GitLab publication",
      );
      const requester = {
        ...requesterSource,
        assertCurrent() {
          requesterSource.assertCurrent();
          if (!pluginCurrent()) {
            throw new Error("GitLab publication tool is no longer active.");
          }
        },
      };
      const bound = await bindPersonalForgeSessionAction(
        options,
        requester,
        input,
        options.req.method,
        "GitLab",
        "operator.sessions.read",
      );
      using _ = { [Symbol.dispose]: bound.release };
      const publisher = await readGitLabPublicationPublisher(
        options,
        bound.action,
        operation.requestId,
      );
      if (publisher.source !== "personal") {
        throw new Error(
          "This tool only reads publications made with your connected My GitLab account.",
        );
      }
      let credential: GitLabPublicationCredential | null = null;
      try {
        credential = personalGitLabPublicationCredential(await service.credential(bound.action));
      } catch {
        bound.action.assertCurrent();
      }
      try {
        const result = await readPersonalGitLabPublicationStatus(
          options,
          bound.action,
          credential,
          operation.requestId,
        );
        bound.action.assertCurrent();
        options.respond(true, result);
      } finally {
        credential?.close();
      }
      return;
    }
    const { action, claim } = await prepareHandoffRequester(options);
    if (input.sessionKey !== claim.sessionKey || input.agentId !== claim.agentId) {
      throw new Error("GitLab publication can only use the requesting conversation.");
    }
    using selected = await prepareGitHubPublicationSession(input.sessionKey, {
      agentId: input.agentId,
      assertCurrent: action.assertCurrent,
    });
    const { loaded } = selected;
    if (!loaded.entry || loaded.entry.sessionId !== claim.sessionId) {
      throw new Error("The requesting conversation changed before publication.");
    }
    const credential = personalGitLabPublicationCredential(await service.credential(action));
    try {
      if (operation.action === "publish" && operation.workspacePath !== undefined) {
        const source = await prepareSessionCreateRequestedCwd({
          cfg: options.context.getRuntimeConfig(),
          requestedCwd: operation.workspacePath,
          clientPresent: true,
          clientScopes: [...claim.operatorAuthority.scopes],
        });
        action.assertCurrent();
        if (!source.ok) {
          throw new Error(source.error.message);
        }
        const sourcePath = source.value;
        if (!sourcePath) {
          throw new Error("GitLab publication requires an explicit local checkout path.");
        }
        if (loaded.entry.worktree) {
          using owner = await resolveLocalWorkspaceOwner({
            sessionKey: input.sessionKey,
            agentId: input.agentId,
            cfg: options.context.getRuntimeConfig(),
            assertCurrent: action.assertCurrent,
          });
          if (!owner || owner.worktree.path !== sourcePath) {
            throw new Error(
              "This conversation already publishes a different checkout; its files were preserved.",
            );
          }
          owner.assertCurrent();
        } else {
          const placements = options.context.workerSessionPlacementService;
          if (!placements?.withLocalWorkspaceReservation) {
            throw new Error("Workspace preparation is unavailable during Gateway startup.");
          }
          let verifiedProjectId: number | undefined;
          await placements.withLocalWorkspaceReservation(
            { sessionKey: input.sessionKey, agentId: input.agentId, sessionId: claim.sessionId },
            (assertOwned) =>
              adoptUnboundPullRequestWorkspace({
                context: options.context,
                target: {
                  sessionKey: input.sessionKey,
                  agentId: input.agentId,
                  storePath: loaded.storePath,
                },
                entry: loaded.entry!,
                localSource: sourcePath,
                signal: action.signal,
                assertCurrent() {
                  action.assertCurrent();
                  credential.assertCurrent();
                  assertOwned();
                  if (verifiedProjectId !== undefined) {
                    assertPersonalGitLabPublicationProjectAllowed(options, verifiedProjectId);
                  }
                },
                async verifyBeforeBinding() {
                  const target = await readPersonalGitLabCheckoutTarget(
                    options,
                    action,
                    sourcePath,
                  );
                  const project = await preparePersonalGitLabPublicationProject(
                    options,
                    action,
                    credential,
                    target,
                  );
                  verifiedProjectId = project.id;
                },
              }),
          );
        }
      }
      const admitted = await retainPersonalForgePublicationSession(
        options,
        action,
        input,
        "GitLab",
        options.req.method,
        "operator.sessions.write",
      );
      using _ = { [Symbol.dispose]: admitted.release };
      const result =
        operation.action === "publish"
          ? await requestPersonalGitLabPublication(options, admitted.action, credential, {
              sessionKey: input.sessionKey,
              agentId: input.agentId,
              idempotencyKey: input.idempotencyKey,
              title: operation.title,
              body: operation.body,
              draft: operation.draft,
              bootstrapDraft: operation.bootstrapDraft,
              baseBranch: operation.baseBranch,
            })
          : await confirmPersonalGitLabPublication(options, admitted.action, credential, {
              sessionKey: input.sessionKey,
              agentId: input.agentId,
              ...operation,
            });
      admitted.action.assertCurrent();
      options.respond(true, result);
    } finally {
      credential.close();
    }
  } catch (error) {
    respondError(
      options.respond,
      ErrorCodes.UNAVAILABLE,
      error instanceof Error
        ? error.message
        : "GitLab publication failed; inspect the original request before retrying.",
    );
  }
};

export const gitLabPublicationToolHandlers: GatewayRequestHandlers = {
  "tools.gitlab.publication.publish": handlePublication,
  "tools.gitlab.publication.status": handlePublication,
  "tools.gitlab.publication.confirm": handlePublication,
};
