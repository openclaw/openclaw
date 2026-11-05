import {
  ErrorCodes,
  errorShape,
  validateCronReauthorizeChannelRequesterParams,
  type CronReauthorizeChannelRequesterParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  CronJobConfigRevisionConflictError,
  resolveCronJobConfigRevision,
} from "../../cron/config-revision.js";
import { cronJobReadView } from "../../cron/job-read-view.js";
import { resolveCronScheduledToolPolicy } from "../../cron/scheduled-tool-policy.js";
import {
  normalizeCronAuthenticatedChannelRequester,
  normalizeCronToolsAllowProvenance,
  resolveCronAuthenticatedCallerOrigin,
} from "../../cron/tools-allow-provenance.js";
import { cronJobUsesToolRuntime } from "../../cron/tools-allow.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import { prepareUserChannelIdentityAuthority } from "../../state/user-channel-identity-operations.js";
import { resolveCronMutationCommitGuard } from "./cron-caller-scope.js";
import { respondCronJobNotFound } from "./cron-job-access.js";
import { respondCronJobConfigRevisionConflict } from "./cron-revision-error.js";
import type { GatewayRequestHandler } from "./types.js";
import { prepareUserProfileAdministration } from "./users-profile-access.js";
import { assertValidParams } from "./validation.js";

class CronReauthorizationForbiddenError extends Error {}

/** Bind provenance only: an administrator cannot use this operation to widen the job. */
export const cronReauthorizeChannelRequesterHandler: GatewayRequestHandler = async (options) => {
  const { params, client, context, respond } = options;
  if (
    !assertValidParams(
      params,
      validateCronReauthorizeChannelRequesterParams,
      "cron.reauthorizeChannelRequester",
      respond,
    )
  ) {
    return;
  }
  // Unlike internal system methods, migration requires an authenticated administrator.
  if (
    !client ||
    client.internal?.agentRuntimeIdentity ||
    (client.connect.role ?? "operator") !== "operator" ||
    !client.connect.scopes?.includes("operator.admin") ||
    !client.authenticatedUserProfile?.profileId
  ) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.FORBIDDEN,
        "Channel requester reauthorization requires an authenticated administrator",
      ),
    );
    return;
  }
  // SAFETY: assertValidParams above validated the complete reauthorization protocol schema.
  const input = params as CronReauthorizeChannelRequesterParams;
  const normalizedRequester = normalizeCronAuthenticatedChannelRequester({ version: 1, ...input });
  if (!normalizedRequester) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Invalid channel requester identity"),
    );
    return;
  }
  const p = { ...input, ...normalizedRequester };
  try {
    let administrator: () => void;
    try {
      administrator = await prepareUserProfileAdministration(options);
    } catch (error) {
      throw new CronReauthorizationForbiddenError(formatErrorMessage(error));
    }
    const assertAdministrator = () => {
      try {
        administrator();
      } catch (error) {
        throw new CronReauthorizationForbiddenError(formatErrorMessage(error));
      }
    };
    const linked = await prepareUserChannelIdentityAuthority({
      channelId: p.channel,
      accountId: p.accountId,
      senderId: p.senderId,
    });
    const assertCurrent = () => {
      assertAdministrator();
      if (!linked || linked.linked.profileId !== p.expectedProfileId || !linked.isCurrent()) {
        throw new TypeError(
          "Exact channel identity link changed or does not match expectedProfileId; verify the durable link and retry",
        );
      }
    };
    assertCurrent();
    if (!(await context.cron.readJob(p.id))) {
      assertCurrent();
      respondCronJobNotFound(respond, p.id);
      return;
    }
    const mutationGuard = resolveCronMutationCommitGuard(client, context, undefined, options);
    const job = await context.cron.updateWithPrecondition(
      p.id,
      {},
      (lockedJob) => {
        assertCurrent();
        const actual = resolveCronJobConfigRevision(lockedJob);
        if (actual !== p.expectedConfigRevision) {
          throw new CronJobConfigRevisionConflictError(p.expectedConfigRevision, actual);
        }
        const origin = resolveCronAuthenticatedCallerOrigin(lockedJob);
        const policy = resolveCronScheduledToolPolicy({
          toolsAllow: lockedJob.payload.toolsAllow,
          owner: lockedJob.owner,
          scheduledToolPolicy: lockedJob.scheduledToolPolicy,
        });
        const requester = normalizeCronToolsAllowProvenance(
          lockedJob.toolsAllowProvenance,
        )?.channelRequester;
        const channelCreated =
          (lockedJob.createdActor?.type === "human" &&
            lockedJob.createdActor.source === "channel") ||
          origin?.kind === "external" ||
          requester !== undefined;
        if (
          !channelCreated ||
          !cronJobUsesToolRuntime(lockedJob) ||
          (requester !== undefined &&
            (requester.channel !== p.channel || requester.accountId !== p.accountId)) ||
          (origin !== undefined && (origin.kind !== "external" || origin.channel !== p.channel)) ||
          policy?.mode !== "account" ||
          policy.ownerAccountId !== p.accountId ||
          normalizeAccountId(lockedJob.owner?.accountId) !== p.accountId
        ) {
          throw new TypeError(
            "Reauthorization requires the original channel-created tool-runtime job and its exact channel/account scope",
          );
        }
      },
      {
        reauthorizeChannelRequester: true,
        toolsAllowProvenance: {
          version: 1,
          source: "authenticated-requester",
          callerOrigin: { kind: "external", channel: p.channel },
          channelRequester: {
            version: 1,
            channel: p.channel,
            accountId: p.accountId,
            senderId: p.senderId,
          },
        },
        commitGuard: () => {
          mutationGuard?.();
          assertCurrent();
        },
      },
    );
    respond(true, cronJobReadView(job));
  } catch (error) {
    if (error instanceof CronJobConfigRevisionConflictError) {
      respondCronJobConfigRevisionConflict(respond, error);
      return;
    }
    respond(
      false,
      undefined,
      errorShape(
        error instanceof CronReauthorizationForbiddenError
          ? ErrorCodes.FORBIDDEN
          : error instanceof TypeError
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE,
        formatErrorMessage(error),
      ),
    );
  }
};
