/** Consent-gated Gateway owner for one sanitized failed-update report. */
import {
  validateUpdateReportParams,
  validateUpdateReportResult,
} from "../../../packages/gateway-protocol/src/index.js";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import { PACKAGE_POST_INSTALL_DOCTOR_ADVISORY } from "../../infra/update-doctor-result.js";
import {
  prepareUpdateFailureReport,
  submitUpdateFailureReport,
  type UpdateFailureReportInput,
  type UpdateFailureReportSubmitResult,
} from "../../infra/update-failure-report.js";
import { classifyUpdateOutcome } from "../../shared/update-outcome.js";
import { refreshLatestUpdateRestartSentinel } from "../server-restart-sentinel.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function readIdentity(value: Record<string, unknown> | null | undefined) {
  return value
    ? {
        ...(typeof value.sha === "string" ? { sha: value.sha } : {}),
        ...(typeof value.version === "string" ? { version: value.version } : {}),
        ...(typeof value.buildId === "string" ? { buildId: value.buildId } : {}),
        ...(typeof value.upstreamRef === "string" ? { upstreamRef: value.upstreamRef } : {}),
      }
    : undefined;
}

function projectReportInput(payload: RestartSentinelPayload): UpdateFailureReportInput | null {
  if (
    payload.kind !== "update" ||
    classifyUpdateOutcome({
      status: payload.status,
      reason: payload.stats?.reason ?? undefined,
    }) !== "failed" ||
    !payload.stats
  ) {
    return null;
  }
  const stats = payload.stats;
  const mode =
    stats.mode === "git" || stats.mode === "pnpm" || stats.mode === "bun" || stats.mode === "npm"
      ? stats.mode
      : "unknown";
  const recovery = stats.recovery;
  return {
    attemptId: stats.handoffId?.trim() || `recorded:${payload.ts}`,
    result: {
      status: payload.status,
      mode,
      ...(typeof stats.reason === "string" ? { reason: stats.reason } : {}),
      ...(readIdentity(stats.before) ? { before: readIdentity(stats.before) } : {}),
      ...(readIdentity(stats.after) ? { after: readIdentity(stats.after) } : {}),
      steps: (stats.steps ?? []).map((step) => {
        const projected: UpdateFailureReportInput["result"]["steps"][number] = {
          name: step.name,
          command: "",
          cwd: "",
          durationMs: step.durationMs ?? 0,
          exitCode: step.log?.exitCode ?? null,
        };
        if (step.advisory) {
          projected.advisory = PACKAGE_POST_INSTALL_DOCTOR_ADVISORY;
        }
        return projected;
      }),
      durationMs: stats.durationMs ?? 0,
      ...(recovery ? { recovery } : {}),
    },
    ...(stats.target ? { target: stats.target } : {}),
  };
}

function projectPublicSubmitResult(
  result: Exclude<UpdateFailureReportSubmitResult, { status: "stale" }>,
) {
  if (result.status === "created") {
    return {
      status: result.status,
      url: result.url,
      ...(result.message ? { message: result.message } : {}),
    };
  }
  if (result.status === "fallback") {
    return {
      status: result.status,
      fallbackUrl: result.fallbackUrl,
      message: result.message,
    };
  }
  return {
    status: result.status,
    message: result.message,
    ...(result.url ? { url: result.url } : {}),
    ...(result.fallbackUrl ? { fallbackUrl: result.fallbackUrl } : {}),
  };
}

export const updateReportHandler: GatewayRequestHandlers["update.report"] = async ({
  hasCurrentClientAuthority,
  params,
  respond,
}) => {
  if (!assertValidParams(params, validateUpdateReportParams, "update.report", respond)) {
    return;
  }
  if (!hasCurrentClientAuthority) {
    respond(false, undefined, {
      code: "INVALID_REQUEST",
      message: "Update report access requires a current authenticated client.",
    });
    return;
  }
  if (!hasCurrentClientAuthority()) {
    return;
  }
  try {
    const sentinel = await refreshLatestUpdateRestartSentinel();
    if (!hasCurrentClientAuthority()) {
      return;
    }
    const input = sentinel ? projectReportInput(sentinel) : null;
    if (!input || input.attemptId !== params.attemptId) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "This failed update attempt is stale or unavailable.",
      });
      return;
    }
    const prepared = await prepareUpdateFailureReport(input);
    if (!hasCurrentClientAuthority()) {
      return;
    }
    let result;
    if (params.action === "preview") {
      if (!hasCurrentClientAuthority()) {
        return;
      }
      result = {
        status: "ready" as const,
        attemptId: prepared.attemptId,
        body: prepared.body,
        previewDigest: prepared.previewDigest,
        title: prepared.title,
      };
    } else {
      const submitted = await submitUpdateFailureReport(prepared, params.previewDigest, {
        hasCurrentAuthority: hasCurrentClientAuthority,
        validateCurrentAttempt: async () => {
          const currentSentinel = await refreshLatestUpdateRestartSentinel();
          const currentInput = currentSentinel ? projectReportInput(currentSentinel) : null;
          return currentInput?.attemptId === params.attemptId;
        },
      });
      if (submitted.status === "stale") {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: submitted.message,
        });
        return;
      }
      result = projectPublicSubmitResult(submitted);
    }
    if (!validateUpdateReportResult(result)) {
      respond(false, undefined, {
        code: "UNAVAILABLE",
        message: "update report status is temporarily unavailable",
      });
      return;
    }
    respond(true, result);
  } catch {
    respond(false, undefined, {
      code: "INVALID_REQUEST",
      message: "Update report could not be prepared safely.",
    });
  }
};
