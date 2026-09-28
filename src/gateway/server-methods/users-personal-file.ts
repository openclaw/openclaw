import { createHash } from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  validateUsersPersonalFileGetParams,
  validateUsersPersonalFileSetParams,
  type UsersPersonalFileGetResult,
  type UsersPersonalFileSetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { assertAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../../agents/workspace-bootstrap-read.js";
import { isMissingPathError } from "../../infra/errors.js";
import { root, FsSafeError } from "../../infra/fs-safe.js";
import { roleScopesAllow } from "../../shared/operator-scope-compat.js";
import {
  hasMultipleSessionSharingIdentities,
  readResidentUserProfileId,
  readUserProfileIdentity,
} from "../../state/user-profile-list.js";
import { resolveOperatorRolePolicyForAssignment } from "../operator-role-policy.js";
import { isGatewayClientProfilePending } from "./gateway-client-identity.js";
import { isIneligiblePersonalGatewayCaller } from "./gateway-personal-caller.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";
import { enqueueWorkspaceFileUpdate } from "./workspace-fs.js";

class PersonalFileAccessError extends Error {}

function preparePersonalFile(options: GatewayRequestHandlerOptions, requestedAgentId: string) {
  const { client, context } = options;
  if (!listAgentIds(context.getRuntimeConfig()).includes(requestedAgentId)) {
    throw new PersonalFileAccessError(
      "Select an existing agent to edit your personal instructions.",
    );
  }
  const agentId = requestedAgentId;
  const workspaceDir = resolveAgentWorkspaceDir(context.getRuntimeConfig(), agentId);
  const operatorAuthority = client?.internal?.operatorRunAuthority;
  const toolCaller = getGatewayToolCallerIdentity();
  const assertToolCurrent = captureGatewayToolCallerAssertion();
  const currentProfile = () => {
    options.sessionMutationCommitGuard?.();
    if (!hasMultipleSessionSharingIdentities()) {
      throw new PersonalFileAccessError(
        "Personal instructions are only available on multi-user Gateways. Use the agent workspace USER.md on a single-user Gateway.",
      );
    }
    if (
      !client ||
      client.invalidated ||
      client.connectionSignal?.aborted ||
      client.connect.role !== "operator" ||
      options.signal?.aborted
    ) {
      throw new PersonalFileAccessError(
        "Personal instructions require a current signed-in connection.",
      );
    }
    let id: string | undefined;
    if (operatorAuthority) {
      // This is the original requesting person, not the session owner or a profile
      // copied onto a synthetic client. Only an exact live, host-admitted tool run
      // may use this narrow self-service exception. Other personal APIs stay unchanged.
      assertAdmittedRunOperatorAuthority(operatorAuthority);
      const requesterAuthority = toolCaller?.operatorAuthority;
      if (
        client.internal?.syntheticClient !== true ||
        !requesterAuthority?.source ||
        requesterAuthority.source !== operatorAuthority.source ||
        requesterAuthority.profileId !== operatorAuthority.profileId ||
        !assertToolCurrent
      ) {
        throw new PersonalFileAccessError("Personal instructions require an admitted user turn.");
      }
      // Dispatch may issue a narrower grant. Bind by the opaque original source
      // and subject, while retaining both the run and narrowed grant lifetimes.
      assertAdmittedRunOperatorAuthority(requesterAuthority);
      assertToolCurrent();
      operatorAuthority.assertCurrent();
      id = operatorAuthority.profileId;
    } else {
      if (
        isIneligiblePersonalGatewayCaller(client) ||
        isGatewayClientProfilePending(client) ||
        !client.connId ||
        !context.getClientConnIds?.((current) => current === client).has(client.connId)
      ) {
        throw new PersonalFileAccessError(
          "Personal instructions require a current signed-in connection.",
        );
      }
      id = client.authenticatedUserProfile?.profileId;
    }
    // Gateway projection owns this resident catalog; never create identities from request input.
    const canonicalId = id ? readResidentUserProfileId(id) : undefined;
    if (!canonicalId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(canonicalId)) {
      throw new PersonalFileAccessError(
        "Sign in with a durable profile to edit personal instructions.",
      );
    }
    const cfg = context.getRuntimeConfig();
    const policy = resolveOperatorRolePolicyForAssignment(
      canonicalId,
      readUserProfileIdentity(canonicalId)?.role ?? null,
      cfg,
    );
    if (
      ![
        client.connect.scopes ?? [],
        ...(operatorAuthority ? [operatorAuthority.scopes] : []),
        ...(policy ? [policy.scopes] : []),
      ].every((allowedScopes) =>
        roleScopesAllow({ role: "operator", requestedScopes: ["operator.read"], allowedScopes }),
      )
    ) {
      throw new PersonalFileAccessError(
        "Personal instructions require current operator.read permission.",
      );
    }
    if (policy && policy.agents !== "*" && !policy.agents.includes(agentId)) {
      throw new PersonalFileAccessError(
        "Your operator role cannot edit personal instructions for this agent.",
      );
    }
    return canonicalId;
  };
  const profileId = currentProfile();
  const assertCurrent = () => {
    const cfg = context.getRuntimeConfig();
    if (
      currentProfile() !== profileId ||
      !listAgentIds(cfg).includes(agentId) ||
      resolveAgentWorkspaceDir(cfg, agentId) !== workspaceDir
    ) {
      throw new PersonalFileAccessError(
        "Profile or agent workspace changed; reload before saving.",
      );
    }
    // The remote document bridge does not expose no-alias writes or a pre-commit authority hook.
    // Never fall back to a same-spelled Gateway path for a remotely owned workspace.
    if (getAgentWorkspaceAccess(workspaceDir)) {
      throw new PersonalFileAccessError(
        "Personal instructions editing requires a local agent workspace.",
      );
    }
  };
  assertCurrent();
  return { agentId, profileId, workspaceDir, name: `users/${profileId}/USER.md`, assertCurrent };
}

function hash(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function runPersonalFile(
  options: GatewayRequestHandlerOptions,
  params: { agentId: string },
  write?: UsersPersonalFileSetParams,
) {
  try {
    const target = preparePersonalFile(options, params.agentId);
    const fsRoot = await root(target.workspaceDir, {
      symlinks: "reject",
      mutationSymlinks: "reject",
      hardlinks: "reject",
      maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
      nonBlockingRead: true,
      assertBeforeMutation: target.assertCurrent,
    });
    const read = async (): Promise<UsersPersonalFileGetResult> => {
      target.assertCurrent();
      try {
        const loaded = await fsRoot.read(target.name);
        target.assertCurrent();
        return {
          agentId: target.agentId,
          profileId: target.profileId,
          missing: false,
          content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(loaded.buffer),
          hash: hash(loaded.buffer),
        };
      } catch (error) {
        target.assertCurrent();
        if (!isMissingPathError(error)) {
          throw error;
        }
        return {
          agentId: target.agentId,
          profileId: target.profileId,
          missing: true,
          content: "",
          hash: null,
        };
      }
    };
    if (!write) {
      const result = await read();
      target.assertCurrent();
      options.respond(true, result);
      return;
    }
    // JS UTF-16 length matches the bootstrap cap, including astral characters.
    if (write.content.length > 4_000) {
      options.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Keep personal instructions within 4,000 characters.",
        ),
      );
      return;
    }
    await enqueueWorkspaceFileUpdate(async () => {
      const previous = await read();
      target.assertCurrent();
      if (previous.hash !== write.expectedHash) {
        options.respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "Personal USER.md changed since it was read. Reload before saving.",
            { details: { type: "personal_file_conflict" } },
          ),
        );
        return;
      }
      // Serializes Gateway saves, including create-if-missing. Independent shell writers
      // keep the existing workspace editor's best-effort conflict contract.
      await fsRoot.write(target.name, write.content, { mkdir: true, overwrite: !previous.missing });
      target.assertCurrent();
      options.respond(true, {
        agentId: target.agentId,
        profileId: target.profileId,
        missing: false,
        content: write.content,
        hash: hash(write.content),
      } satisfies UsersPersonalFileGetResult);
    });
  } catch (error) {
    options.respond(
      false,
      undefined,
      errorShape(
        error instanceof PersonalFileAccessError
          ? ErrorCodes.FORBIDDEN
          : ErrorCodes.INVALID_REQUEST,
        error instanceof FsSafeError
          ? "Personal USER.md could not be accessed safely. Check the agent workspace and remove file aliases."
          : error instanceof Error
            ? error.message
            : "Personal instructions are unavailable; reload and try again.",
      ),
    );
  }
}

export const usersPersonalFileHandlers: GatewayRequestHandlers = {
  "users.personalFile.get": defineValidatedGatewayMethod(
    "users.personalFile.get",
    validateUsersPersonalFileGetParams,
    (options) => runPersonalFile(options, options.params),
  ),
  "users.personalFile.set": defineValidatedGatewayMethod(
    "users.personalFile.set",
    validateUsersPersonalFileSetParams,
    (options) => runPersonalFile(options, options.params, options.params),
  ),
};
