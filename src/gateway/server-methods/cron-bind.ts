import { validateCronBindParams } from "../../../packages/gateway-protocol/src/index.js";
import { tryResolveCronJobEffectiveAgentId } from "../../cron/agent-id.js";
import { resolveCronBindParent } from "../../cron/bind-parent.js";
import {
  CronJobConfigRevisionConflictError,
  resolveCronJobConfigRevision,
} from "../../cron/config-revision.js";
import { cronJobReadView } from "../../cron/job-read-view.js";
import { resolveCronOperatorExecutionRevision } from "../../cron/service/jobs-tool-policy.js";
import type { CronStoredJob } from "../../cron/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getCronManagementAuthority } from "../cron-creator-authority-grant.js";
import { assertActiveAgentRuntimeAuthority } from "./agent-runtime-authority.js";
import {
  cronJobMatchesCallerScope,
  readCronCallerScope,
  resolveCronMutationCommitGuard,
  type CronCallerScope,
} from "./cron-caller-scope.js";
import { prepareCronCreatorSession } from "./cron-creator-session.js";
import { isCronInvalidRequestError } from "./cron-error-classification.js";
import { captureCronCreatorSession } from "./cron-input-validation.js";
import {
  resolveCronJobId,
  respondCronJobNotFound,
  respondInvalidCronParams,
  respondMissingCronJobId,
} from "./cron-job-access.js";
import { respondCronJobConfigRevisionConflict } from "./cron-revision-error.js";
import type { GatewayRequestHandler, GatewayRequestHandlerOptions } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

const BIND_OWNER_TURN_REQUIRED =
  "cron bind requires an authenticated owner turn in the automation's parent conversation (a Control UI administrator or the configured channel owner).";
const BIND_WRONG_CONVERSATION =
  "cron bind must run from this automation's parent conversation; this conversation is not its parent.";
const BIND_OTHER_AGENT =
  "cron bind: this automation runs as a different agent than this conversation, so it cannot use it as its parent.";

/** The caller's own conversation, admitted only for an owner turn holding the management grant. */
function resolveBindCaller(
  options: Pick<GatewayRequestHandlerOptions, "client">,
): { callerScope: CronCallerScope } | { refusal: string } {
  const identity = options.client?.internal?.agentRuntimeIdentity;
  const callerScope = readCronCallerScope(options.client);
  if (!identity || !callerScope?.sessionKey) {
    return {
      refusal:
        "cron bind must run from the automation's parent conversation; ask the agent in that conversation to bind it.",
    };
  }
  if (!getCronManagementAuthority(identity)) {
    return { refusal: BIND_OWNER_TURN_REQUIRED };
  }
  // Management access widens job visibility; bind stays limited to the caller's own jobs.
  return { callerScope: { ...callerScope, manageAll: undefined } };
}

/** Refusal for a job this conversation cannot bind, or the parent key it binds. */
function resolveBindTarget(
  job: CronStoredJob,
  callerScope: CronCallerScope,
  defaultAgentId: string | undefined,
): string | { refusal: string } {
  const parent = resolveCronBindParent(job);
  if ("refusal" in parent) {
    return parent;
  }
  if (!cronJobMatchesCallerScope({ job, callerScope, defaultAgentId })) {
    return { refusal: BIND_WRONG_CONVERSATION };
  }
  // The caller scope matches on the stamped owner; occurrences run as the job's effective
  // agent and look the parent up in that agent's sessions, so both must be this agent.
  if (tryResolveCronJobEffectiveAgentId(job, defaultAgentId) !== callerScope.agentId) {
    return { refusal: BIND_OTHER_AGENT };
  }
  return parent.parentSessionKey;
}

/**
 * `cron.bind`: records the current incarnation of a key-only job's parent conversation as
 * its `sourceConversation`, moving it from `unbound-parent` to an exact parent principal.
 * The conversation comes from the caller's signed runtime identity, never from params.
 */
export const cronBindHandler: GatewayRequestHandler = defineValidatedGatewayHandler(
  "cron.bind",
  validateCronBindParams,
  async (options) => {
    const { params, respond, context, client, signal } = options;
    const { sessionMutationCommitGuard, hasCurrentClientAuthority } = options;
    assertActiveAgentRuntimeAuthority(client, context);
    sessionMutationCommitGuard?.();
    if (hasCurrentClientAuthority?.() === false) {
      throw new Error("Automation caller authority is no longer active");
    }
    const jobId = resolveCronJobId(params);
    if (!jobId) {
      respondMissingCronJobId(respond, "cron.bind");
      return;
    }
    const caller = resolveBindCaller(options);
    if ("refusal" in caller) {
      respondInvalidCronParams(respond, "cron.bind", caller.refusal);
      return;
    }
    const { callerScope } = caller;
    const defaultAgentId = context.cron.getDefaultAgentId();
    const job = await context.cron.readJob(jobId);
    if (!job) {
      respondCronJobNotFound(respond, jobId);
      return;
    }
    const target = resolveBindTarget(job, callerScope, defaultAgentId);
    if (typeof target !== "string") {
      respondInvalidCronParams(respond, "cron.bind", target.refusal);
      return;
    }
    const cfg = context.getRuntimeConfig();
    let creator: Awaited<ReturnType<typeof prepareCronCreatorSession>>;
    let capture: Awaited<ReturnType<typeof captureCronCreatorSession>>;
    try {
      // One read pins the parent incarnation for the commit fence; the capture reads the
      // same row to build sourceConversation and, for a Control UI operator turn, the
      // operator-source snapshot exactly as creation from this turn would.
      creator = await prepareCronCreatorSession({
        context,
        client,
        callerScope,
        sessionMutationCommitGuard,
        hasCurrentClientAuthority,
      });
      capture = await captureCronCreatorSession(
        job,
        callerScope,
        { client, context, signal },
        cfg,
        true,
      );
    } catch (err) {
      respondInvalidCronParams(respond, "cron.bind", formatErrorMessage(err));
      return;
    }
    const sourceConversation = capture.sourceConversation;
    const session = creator.session;
    if (
      !sourceConversation ||
      !session ||
      sourceConversation.sessionKey !== target ||
      session.sessionKey !== target
    ) {
      respondInvalidCronParams(respond, "cron.bind", BIND_WRONG_CONVERSATION);
      return;
    }
    if (
      session.entry.sessionId !== sourceConversation.sessionId ||
      session.entry.lifecycleRevision !== sourceConversation.lifecycleRevision
    ) {
      respondInvalidCronParams(
        respond,
        "cron.bind",
        "Parent conversation changed while binding; retry from the current turn.",
      );
      return;
    }
    if (typeof session.entry.archivedAt === "number") {
      respondInvalidCronParams(
        respond,
        "cron.bind",
        "cron bind cannot bind an archived conversation; restore it first.",
      );
      return;
    }
    const expectedConfigRevision = resolveCronJobConfigRevision(job);
    const commitGuard = resolveCronMutationCommitGuard(client, context, undefined, {
      sessionMutationCommitGuard: () => {
        sessionMutationCommitGuard?.();
        creator.assertCurrent();
        capture.assertOperatorSourceCurrent?.();
      },
      hasCurrentClientAuthority,
    });
    let bound: Awaited<ReturnType<typeof context.cron.updateWithPrecondition>>;
    try {
      bound = await context.cron.updateWithPrecondition(
        jobId,
        {},
        (lockedJob) => {
          // The definition the caller inspected must still be the one it binds.
          if (resolveCronJobConfigRevision(lockedJob) !== expectedConfigRevision) {
            throw new CronJobConfigRevisionConflictError(
              expectedConfigRevision,
              resolveCronJobConfigRevision(lockedJob),
            );
          }
        },
        {
          bindSourceConversation: sourceConversation,
          ...(capture.operatorSource
            ? {
                operatorSource: capture.operatorSource,
                // The snapshot binds to the definition as it will be stored, link included.
                operatorSourceExecutionRevision: resolveCronOperatorExecutionRevision({
                  ...job,
                  sourceConversation,
                }),
              }
            : {}),
          sessionEntryCurrent: creator.sessionEntryCurrent,
          commitGuard,
        },
      );
    } catch (err) {
      if (err instanceof CronJobConfigRevisionConflictError) {
        respondCronJobConfigRevisionConflict(respond, err);
        return;
      }
      if (!(err instanceof TypeError) && !isCronInvalidRequestError(err)) {
        throw err;
      }
      respondInvalidCronParams(respond, "cron.bind", formatErrorMessage(err));
      return;
    }
    context.logGateway.info("cron: job bound to parent conversation", { jobId });
    respond(
      true,
      {
        ...cronJobReadView(bound),
        // Report what was stored: the store drops a capture that does not fit the job.
        bound: { operatorSource: context.cron.getJob(jobId)?.operatorSource !== undefined },
      },
      undefined,
    );
  },
);
