/** Consent-gated Gateway owner for one sanitized failed-update report. */
import {
  ErrorCodes,
  validateUpdateReportParams,
  type UpdateReportResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import {
  prepareUpdateFailureReport,
  submitUpdateFailureReport,
} from "../../infra/update-failure-report.js";
import { getUpdateRunStatusAsync } from "../../infra/update-run-reader.js";
import { isReportableUpdateRun } from "../../shared/update-outcome-classification.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

async function readCurrentReportInput() {
  const { activeRun, lastRun } = await getUpdateRunStatusAsync();
  const run = activeRun ?? lastRun;
  return run && isReportableUpdateRun(run) ? run : null;
}

function hasUpdateReportOwnerAuthority(
  client: Parameters<GatewayRequestHandlers["update.report"]>[0]["client"],
): boolean {
  return (
    client?.internal?.operatorRoleActor?.kind === "system" ||
    client?.authenticatedUserProfile?.profileId === GATEWAY_OWNER_PROFILE_ID
  );
}

export const updateReportHandler = defineValidatedGatewayHandler(
  "update.report",
  validateUpdateReportParams,
  async ({ client, context, hasCurrentClientAuthority, params, respond }) => {
    if (!hasCurrentClientAuthority) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "Update report access requires a current authenticated client.",
      });
      return;
    }
    const profileId = client?.authenticatedUserProfile?.profileId;
    const systemActor = client?.internal?.operatorRoleActor?.kind === "system";
    const publicationMode = hasUpdateReportOwnerAuthority(client) ? "host" : "browser";
    if (publicationMode === "browser" && !profileId?.trim()) {
      respond(false, undefined, {
        code: ErrorCodes.FORBIDDEN,
        message: "Update failure reports require an identified administrator.",
      });
      return;
    }
    // Unlike ordinary admitted RPCs, report consent ends with its originating connection.
    // A delegated caller must also retain its run claim through the final effect.
    const runtimeIdentity = client?.internal?.agentRuntimeIdentity;
    const hasCurrentReportAuthority = () =>
      !client?.connectionSignal?.aborted &&
      hasCurrentClientAuthority() &&
      (!runtimeIdentity ||
        context.validateAgentRuntimeApprovalAuthority?.(runtimeIdentity) === true) &&
      client?.authenticatedUserProfile?.profileId === profileId &&
      (client?.internal?.operatorRoleActor?.kind === "system") === systemActor &&
      (publicationMode === "browser" || hasUpdateReportOwnerAuthority(client));
    if (!hasCurrentReportAuthority()) {
      return;
    }
    try {
      const input = await readCurrentReportInput();
      if (!hasCurrentReportAuthority()) {
        return;
      }
      if (!input || input.runId !== params.attemptId) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "This failed update attempt is stale or unavailable.",
        });
        return;
      }
      const prepared = await prepareUpdateFailureReport(input);
      if (!hasCurrentReportAuthority()) {
        return;
      }
      let result: UpdateReportResult;
      if (params.action === "preview") {
        result = {
          status: "ready",
          attemptId: prepared.attemptId,
          body: prepared.body,
          previewDigest: prepared.previewDigest,
          title: prepared.title,
        };
      } else {
        // An admitted publication settles even when the connection retires during transport.
        const submitted = await context.trackExecution(() =>
          submitUpdateFailureReport(prepared, params.previewDigest, {
            publicationMode,
            hasCurrentAuthority: hasCurrentReportAuthority,
            validateCurrentAttempt: async () => {
              const currentInput = await readCurrentReportInput();
              if (currentInput?.runId !== params.attemptId) {
                return false;
              }
              const currentPrepared = await prepareUpdateFailureReport(currentInput);
              return currentPrepared.previewDigest === prepared.previewDigest;
            },
          }),
        );
        if (submitted.status === "stale") {
          respond(false, undefined, {
            code: "INVALID_REQUEST",
            message: submitted.message,
          });
          return;
        }
        if (submitted.status === "created") {
          result = {
            status: submitted.status,
            url: submitted.url,
            ...(submitted.message ? { message: submitted.message } : {}),
          };
        } else if (submitted.status === "fallback") {
          result = {
            status: submitted.status,
            fallbackUrl: submitted.fallbackUrl,
            message: submitted.message,
          };
        } else {
          result = {
            status: submitted.status,
            message: submitted.message,
          };
        }
      }
      if (!hasCurrentReportAuthority()) {
        return;
      }
      respond(true, result);
    } catch {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "Update report could not be prepared safely.",
      });
    }
  },
);
