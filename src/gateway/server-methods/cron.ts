import {
  ErrorCodes,
  errorShape,
  validateCronGetParams,
  validateCronRemoveParams,
  validateCronStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { bindCronSelfRemovalCommitGuard } from "../../cron/active-jobs.js";
import {
  CronJobConfigRevisionConflictError,
  resolveCronJobConfigRevision,
} from "../../cron/config-revision.js";
import { cronJobReadView } from "../../cron/job-read-view.js";
import { CronStoreSelectionRequiredError } from "../../cron/store/selection-error.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  getCronManagementAuthority,
  withCronManagementGrant,
} from "../cron-creator-authority-grant.js";
import { assertActiveAgentRuntimeAuthority } from "./agent-runtime-authority.js";
import { cronAddHandler } from "./cron-add.js";
import { cronBindHandler } from "./cron-bind.js";
import {
  cronJobMatchesCallerScope,
  readCronCallerScope,
  resolveCronMutationCommitGuard,
} from "./cron-caller-scope.js";
import { isCronInvalidRequestError } from "./cron-error-classification.js";
import { cronHistoryHandler } from "./cron-history.js";
import {
  assertCronReadCurrent,
  respondInvalidCronParams,
  respondCronJobNotFound,
  scopedCronJobHandler,
} from "./cron-job-access.js";
import { cronListHandler } from "./cron-list.js";
import { respondCronJobConfigRevisionConflict } from "./cron-revision-error.js";
import { cronRunHandler } from "./cron-run.js";
import { cronRunsHandler } from "./cron-runs.js";
import { cronScratchHandlers } from "./cron-scratch.js";
import { cronUpdateHandler } from "./cron-update.js";
import { cronWakeHandler } from "./cron-wake.js";
import type { GatewayReadErrorHandler } from "./prepared-read.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const cronHandlers: GatewayRequestHandlers = {
  wake: cronWakeHandler,
  "cron.list": cronListHandler,
  "cron.status": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateCronStatusParams, "cron.status", respond)) {
      return;
    }
    respond(true, await context.cron.status(), undefined);
  },
  "cron.get": scopedCronJobHandler(
    "cron.get",
    validateCronGetParams,
    ({ respond }, { job }) => respond(true, cronJobReadView(job), undefined),
    {
      allowCurrentJob: true,
      checkVisibility: true,
      // Shipped CLI matchers parse this wording for name lookup fallback.
      preserveCronGetWireMessage: true,
    },
  ),
  ...cronScratchHandlers,
  "cron.add": cronAddHandler,
  "cron.bind": cronBindHandler,
  "cron.update": cronUpdateHandler,
  "cron.remove": scopedCronJobHandler(
    "cron.remove",
    validateCronRemoveParams,
    async (
      { params, respond, context, client, sessionMutationCommitGuard, hasCurrentClientAuthority },
      { jobId, callerScope, job },
    ) => {
      const defaultAgentId = context.cron.getDefaultAgentId();
      const usesCurrentJobCapability = !cronJobMatchesCallerScope({
        job,
        callerScope,
        defaultAgentId,
      });
      const expectedConfigRevision = usesCurrentJobCapability
        ? resolveCronJobConfigRevision(job)
        : undefined;
      const removalRevision = params.expectedConfigRevision ?? expectedConfigRevision;
      let result: Awaited<ReturnType<typeof context.cron.remove>>;
      try {
        let commitGuard = resolveCronMutationCommitGuard(
          client,
          context,
          {
            callerScope,
            jobId,
            allowCurrentJob: usesCurrentJobCapability,
            expectedConfigRevision,
          },
          { sessionMutationCommitGuard, hasCurrentClientAuthority },
        );
        const identity = client?.internal?.agentRuntimeIdentity;
        const validateAuthority = context.validateAgentRuntimeApprovalAuthority;
        if (identity && validateAuthority && commitGuard && callerScope?.currentJobId === jobId) {
          commitGuard = bindCronSelfRemovalCommitGuard(
            jobId,
            identity.operationalRunInstance,
            commitGuard,
            () => {
              if (
                !validateAuthority(identity) ||
                readCronCallerScope(client)?.currentJobId !== jobId
              ) {
                throw new TypeError("cron self-removal authority is no longer active");
              }
            },
          );
        }
        result =
          commitGuard || removalRevision !== undefined
            ? await context.cron.remove(jobId, {
                ...(commitGuard ? { commitGuard } : {}),
                ...(removalRevision !== undefined
                  ? { expectedConfigRevision: removalRevision }
                  : {}),
              })
            : await context.cron.remove(jobId);
      } catch (error) {
        if (error instanceof CronJobConfigRevisionConflictError) {
          respondCronJobConfigRevisionConflict(respond, error);
          return;
        }
        if (error instanceof TypeError || isCronInvalidRequestError(error)) {
          respondInvalidCronParams(respond, "cron.remove", formatErrorMessage(error));
          return;
        }
        throw error;
      }
      if (!result.removed) {
        respondCronJobNotFound(respond, jobId);
        return;
      }
      context.logGateway.info("cron: job removed", { jobId });
      respond(true, result, undefined);
    },
    { allowCurrentJob: true },
  ),
  "cron.run": cronRunHandler,
  "cron.history": cronHistoryHandler,
  "cron.runs": cronRunsHandler,
};

// The existing one-use grant is request-scoped; the original runtime identity
// stays intact so deferred cron commits still fence the exact admitted run.
for (const [method, handler] of Object.entries(cronHandlers)) {
  const invoke: GatewayRequestHandler = async (args) => {
    const identity = args.client?.internal?.agentRuntimeIdentity;
    if (!identity) {
      return await handler(args);
    }
    const grant = identity.cronManagementGrant;
    let succeeded = false;
    const run = async () => {
      assertActiveAgentRuntimeAuthority(args.client, args.context);
      await handler({
        ...args,
        respond: (...response) => {
          // Reads release data here; mutations already checked at commit. A late
          // acknowledgement must not turn a committed effect into a retryable denial.
          if (
            method === "cron.list" ||
            method === "cron.get" ||
            method === "cron.runs" ||
            method === "cron.history"
          ) {
            assertActiveAgentRuntimeAuthority(args.client, args.context);
            getCronManagementAuthority(identity)?.();
          }
          succeeded = response[0];
          args.respond(...response);
        },
      });
    };
    try {
      await (grant ? withCronManagementGrant(grant, identity, method, run) : run());
    } catch (error) {
      if (!(error instanceof TypeError)) {
        throw error;
      }
      respondInvalidCronParams(args.respond, method, error.message);
    } finally {
      if (grant) {
        args.context.logGateway.info("cron: admin management", {
          method,
          runId: identity.operationalRunInstance.runId,
          instanceId: identity.operationalRunInstance.instanceId,
          ok: succeeded,
        });
      }
    }
  };
  const respondError: GatewayReadErrorHandler = (error, args) => {
    if (!(error instanceof CronStoreSelectionRequiredError)) {
      if (handler.onReadError) {
        handler.onReadError(error, args);
        return;
      }
      throw error;
    }
    assertCronReadCurrent(args);
    args.respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, error.message, {
        retryable: false,
        details: { code: error.code, selection: error.selection },
      }),
    );
  };
  const wrapped: GatewayRequestHandler = async (args) => {
    try {
      await invoke(args);
    } catch (error) {
      respondError(error, args);
    }
  };
  if (handler.prepareRead) {
    const prepareRead = handler.prepareRead;
    wrapped.prepareRead = (args) =>
      args.client?.internal?.agentRuntimeIdentity
        ? { run: (respond) => wrapped({ ...args, respond }) }
        : prepareRead(args);
    wrapped.onReadError = respondError;
  }
  cronHandlers[method] = wrapped;
}
