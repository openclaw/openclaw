import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsCreateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionPlacementAdmissionProvider } from "../../agents/session-placement-admission.js";
import { assertRequiredWorkerSelection } from "../../config/required-worker-profile.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";

export function prepareRequiredWorkerSessionCreate(
  params: SessionsCreateParams,
  config: OpenClawConfig,
): { requiredProfile?: string; automaticEmptyWorkspace: boolean; error?: ErrorShape } {
  const requiredProfile = config.cloudWorkers?.requiredProfile;
  try {
    assertRequiredWorkerSelection(config, params);
  } catch (error) {
    return {
      requiredProfile,
      automaticEmptyWorkspace: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)),
    };
  }
  if (!requiredProfile || params.repository || params.catalogId || params.worktree === true) {
    return { requiredProfile, automaticEmptyWorkspace: false };
  }
  params.worktree = true;
  if (!params.cwd && !params.projectId && !params.projectGitUrl) {
    params.worktreeSource = "empty";
    return { requiredProfile, automaticEmptyWorkspace: true };
  }
  return { requiredProfile, automaticEmptyWorkspace: false };
}

export function assertRequiredWorkerSessionCreateCurrent(
  config: OpenClawConfig,
  requiredProfile: string | undefined,
  params: SessionsCreateParams,
): void {
  if (config.cloudWorkers?.requiredProfile !== requiredProfile) {
    throw new Error("Required worker policy changed during session creation; retry.");
  }
  assertRequiredWorkerSelection(config, params);
}

/** An automatic empty checkout may never replace an already accepted workspace. */
export function requiredWorkerWorkspaceReuseError(
  automaticEmptyWorkspace: boolean,
  existingTargetEntry: SessionEntry | undefined,
): ErrorShape | undefined {
  if (
    automaticEmptyWorkspace &&
    existingTargetEntry &&
    !existingTargetEntry.worktree &&
    (existingTargetEntry.sessionRoot ||
      existingTargetEntry.spawnedCwd ||
      existingTargetEntry.projectId)
  ) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "Required worker setup cannot replace an existing workspace with an empty one; create a managed-workspace session with the original source.",
    );
  }
  return undefined;
}

export async function prepareRequiredWorkerCreatedSession(params: {
  requiredProfile: string | undefined;
  pendingWorktree: boolean;
  requestedProjectGitUrl: string | undefined;
  prepare: SessionPlacementAdmissionProvider["withRequiredSession"];
  session: { entry: Pick<SessionEntry, "sessionId">; key: string; agentId: string };
  assertCurrent: () => void;
  signal?: AbortSignal;
}): Promise<void> {
  if (!params.requiredProfile || params.pendingWorktree || params.requestedProjectGitUrl) {
    return;
  }
  if (!params.prepare) {
    throw new Error(
      "Required worker placement is unavailable; repair the configured profile and retry.",
    );
  }
  await params.prepare(
    {
      sessionId: params.session.entry.sessionId,
      sessionKey: params.session.key,
      agentId: params.session.agentId,
    },
    async (assertCurrent) => {
      params.assertCurrent();
      assertCurrent();
    },
    params.assertCurrent,
    params.signal,
    { waitForReady: false },
  );
}
