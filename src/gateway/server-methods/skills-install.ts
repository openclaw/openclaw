import {
  buildClawHubTrustErrorDetails,
  ErrorCodes,
  errorShape,
  type SkillsInstallParams,
  validateSkillsInstallParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { retainMutationAuthority } from "../../infra/mutation-authority.js";
import { getOrCreatePromise } from "../../shared/lazy-promise.js";
import { installSkillFromClawHub } from "../../skills/lifecycle/clawhub.js";
import { installSkill } from "../../skills/lifecycle/install.js";
import { installUploadedSkillArchive } from "../../skills/lifecycle/upload-install.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { captureGatewayClientUploadCommitGuard } from "../upload-policy.js";
import { resolveSkillsAgentWorkspace } from "./skills-workspace-handler.js";
import type { GatewayRequestHandler } from "./types.js";
import { assertValidParams } from "./validation.js";

type ClawHubInstallResult = Awaited<ReturnType<typeof installSkillFromClawHub>>;
type ClawHubInstallParams = Parameters<typeof installSkillFromClawHub>[0];

const clawHubInstallsInFlight = new Map<string, Promise<ClawHubInstallResult>>();

function installClawHubSkillDeduped(params: ClawHubInstallParams): Promise<ClawHubInstallResult> {
  // A WebSocket can disappear after the request reached the Gateway. Keep one
  // exact install per workspace in flight so a reconnect can safely reattach.
  const key = JSON.stringify([
    params.workspaceDir,
    params.slug,
    params.version ?? null,
    params.force ?? false,
  ]);
  return getOrCreatePromise(clawHubInstallsInFlight, key, () => installSkillFromClawHub(params), {
    evictOnSettled: true,
  });
}

export const handleSkillsInstall: GatewayRequestHandler = async ({
  params,
  respond,
  context,
  client,
}) => {
  if (!assertValidParams(params, validateSkillsInstallParams, "skills.install", respond)) {
    return;
  }
  const p: SkillsInstallParams = params;
  const resolved = resolveSkillsAgentWorkspace(params, context);
  if (!resolved.ok) {
    respond(false, undefined, resolved.error);
    return;
  }
  const cfg = resolved.cfg;
  const workspaceDirRaw = resolved.workspaceDir;
  // Skill installs are intentionally routed by source; each source owns its
  // validation, provenance checks, and result payload shape.
  if ("source" in p && p.source === "clawhub") {
    const result = await installClawHubSkillDeduped({
      workspaceDir: workspaceDirRaw,
      slug: p.slug,
      version: p.version,
      force: Boolean(p.force),
      logger: context.logGateway,
      config: cfg,
    });
    const errorDetails = result.ok ? undefined : buildClawHubTrustErrorDetails(result);
    respond(
      result.ok,
      result.ok
        ? {
            ok: true,
            message: `Installed ${result.slug}@${result.version}`,
            stdout: "",
            stderr: "",
            code: 0,
            slug: result.slug,
            version: result.version,
            targetDir: result.targetDir,
            ...(result.warning ? { warning: result.warning } : {}),
          }
        : result,
      result.ok
        ? undefined
        : errorShape(
            ErrorCodes.UNAVAILABLE,
            result.error,
            errorDetails ? { details: errorDetails } : undefined,
          ),
    );
    return;
  }
  if ("source" in p && p.source === "upload") {
    const uploadGuard = captureGatewayClientUploadCommitGuard({
      method: "skills.install",
      requestParams: p,
      client,
      context,
    });
    const assertCommitAllowed = uploadGuard ? retainMutationAuthority(uploadGuard) : undefined;
    try {
      const result = await installUploadedSkillArchive({
        uploadId: p.uploadId,
        slug: p.slug,
        force: Boolean(p.force),
        sha256: p.sha256,
        timeoutMs: p.timeoutMs,
        workspaceDir: workspaceDirRaw,
        config: cfg,
        log: context.logGateway,
        beforePersistentApply: assertCommitAllowed,
      });
      if (!result.ok) {
        // Install owners return failure envelopes after rollback/lease cleanup. Retain
        // their original policy refusal instead of flattening it to UNAVAILABLE.
        assertCommitAllowed?.();
      }
      const errorCode =
        !result.ok && result.errorKind === "invalid-request"
          ? ErrorCodes.INVALID_REQUEST
          : ErrorCodes.UNAVAILABLE;
      const responseResult = result.ok
        ? result
        : {
            ok: false,
            error: result.error,
            errorCode,
          };
      respond(
        result.ok,
        responseResult,
        result.ok ? undefined : errorShape(errorCode, result.error),
      );
    } catch (error) {
      if (!(error instanceof SessionMutationAuthorizationChangedError)) {
        throw error;
      }
      respond(false, undefined, error.error);
    }
    return;
  }
  const result = await installSkill({
    workspaceDir: workspaceDirRaw,
    agentId: resolved.agentId,
    skillName: p.name,
    installId: p.installId,
    timeoutMs: p.timeoutMs,
    config: cfg,
  });
  respond(
    result.ok,
    result,
    result.ok ? undefined : errorShape(ErrorCodes.UNAVAILABLE, result.message),
  );
};
