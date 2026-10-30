import {
  ErrorCodes,
  errorShape,
  validateCronModelImpactParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolvePublishedModelCatalogOwner } from "../../agents/prepared-model-catalog-owner.js";
import {
  getPublishedPreparedModelCatalogOwnerSnapshot,
  materializePreparedModelCatalogOwner,
} from "../../agents/prepared-model-catalog.js";
import { getPreparedModelRuntimeAuthMaterializations } from "../../agents/prepared-model-runtime-auth.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { resolveCronJobConfigRevision } from "../../cron/config-revision.js";
import { resolveCronAgentSessionKey } from "../../cron/isolated-agent/session-key.js";
import {
  deriveCronModelImpactConfig,
  resolveCronModelImpact,
  type CronModelImpactOwner,
  type CronModelImpactSession,
} from "../../cron/model-impact.js";
import { resolveCronSessionTargetSessionKey } from "../../cron/session-target.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { cronJobMatchesCallerScope, readCronCallerScope } from "./cron-caller-scope.js";
import { assertCronReadCurrent, respondInvalidCronParams } from "./cron-job-access.js";
import { createCronSessionVisibility, cronJobIsVisible } from "./cron-visibility.js";
import type { GatewayRequestHandler } from "./types.js";
import { assertValidParams } from "./validation.js";

/** One shared preview for UI, CLI and model callers, with ordinary cron read visibility. */
export const cronModelImpactHandler: GatewayRequestHandler = async (options) => {
  const { params, respond, context, client } = options;
  if (!assertValidParams(params, validateCronModelImpactParams, "cron.modelImpact", respond)) {
    return;
  }
  const input = {
    ...params,
    ...(params.agentId ? { agentId: normalizeAgentId(params.agentId.trim()) } : {}),
  };
  const cfg = context.getRuntimeConfig();
  const scope = readCronCallerScope(client);
  if (scope && !scope.manageAll && input.agentId && scope.agentId !== input.agentId) {
    respondInvalidCronParams(respond, "cron.modelImpact", "agentId outside caller scope");
    return;
  }
  try {
    deriveCronModelImpactConfig(cfg, input);
  } catch {
    respondInvalidCronParams(
      respond,
      "cron.modelImpact",
      "unknown agentId or invalid proposed primary model",
    );
    return;
  }
  const visibility = createCronSessionVisibility(client, context);
  await visibility.prepare();
  assertCronReadCurrent(options);
  const inventoryLimited = Boolean(scope && !scope.manageAll) || visibility.resolve() !== undefined;
  const defaultAgentId = context.cron.getDefaultAgentId();
  const matches = (job: Parameters<typeof cronJobIsVisible>[0]) =>
    cronJobMatchesCallerScope({
      job,
      callerScope: readCronCallerScope(client),
      defaultAgentId,
      allowCurrentJob: true,
    }) && cronJobIsVisible(job, visibility.resolve(), defaultAgentId);
  const listed = await context.cron.list({ includeDisabled: true });
  assertCronReadCurrent(options);
  const jobs = listed.flatMap((listedJob) => {
    const job = context.cron.getJob(listedJob.id);
    return job && matches(job) ? [job] : [];
  });
  const revisions = new Map(jobs.map((job) => [job.id, resolveCronJobConfigRevision(job)]));
  const owners = new Map<string, CronModelImpactOwner | undefined>();
  const sessions = new Map<string, Promise<CronModelImpactSession>>();
  const result = await resolveCronModelImpact({
    cfg,
    input,
    jobs,
    defaultAgentId,
    ownerForAgent(agentId) {
      if (!owners.has(agentId)) {
        const snapshot = getPublishedPreparedModelCatalogOwnerSnapshot({ config: cfg, agentId });
        let owner: CronModelImpactOwner | undefined;
        if (snapshot?.isCurrent()) {
          try {
            owner = {
              ...resolvePublishedModelCatalogOwner(materializePreparedModelCatalogOwner(snapshot)),
              authMaterializations: getPreparedModelRuntimeAuthMaterializations(snapshot),
            };
          } catch {
            // An owner can be published before paired auth/catalog facts become available.
          }
        }
        owners.set(agentId, owner);
      }
      return owners.get(agentId);
    },
    readSession(job, agentId) {
      // Captured current jobs intentionally do not inherit their creating conversation's selection.
      if (job.sessionTarget === "current" && job.inferenceBinding?.runtime) {
        return Promise.resolve({ available: true });
      }
      const raw =
        job.sessionTarget === "main"
          ? "main"
          : (resolveCronSessionTargetSessionKey(job.sessionTarget) ??
            (job.sessionTarget === "current" ? job.sessionKey : undefined) ??
            "cron:" + job.id);
      const sessionKey = resolveCronAgentSessionKey({
        sessionKey: raw,
        agentId,
        cfg,
        mainKey: cfg.session?.mainKey,
      });
      // Job-management visibility does not grant read access to another private execution session.
      if (
        (job.sessionTarget === "main" ||
          job.sessionTarget.startsWith("session:") ||
          (job.sessionTarget === "current" && Boolean(job.sessionKey))) &&
        visibility.resolve()?.(sessionKey, agentId) === false
      ) {
        return Promise.resolve({ available: false });
      }
      const key = agentId + "\0" + sessionKey;
      let pending = sessions.get(key);
      if (!pending) {
        pending = readSessionEntryInWorker({
          agentId,
          sessionKey,
          storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }),
        }).then(
          (entry): CronModelImpactSession => ({ entry, available: true }),
          (): CronModelImpactSession => ({ available: false }),
        );
        sessions.set(key, pending);
      }
      return pending;
    },
  });
  assertCronReadCurrent(options);
  if (
    context.getRuntimeConfig() !== cfg ||
    [...owners.values()].some((owner) => owner && !owner.isCurrent())
  ) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        "Model metadata changed during preview. Refresh and try again.",
      ),
    );
    return;
  }
  for (const job of jobs) {
    const current = context.cron.getJob(job.id);
    if (
      !current ||
      !matches(current) ||
      resolveCronJobConfigRevision(current) !== revisions.get(job.id)
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "Automation visibility or configuration changed during preview. Refresh and try again.",
        ),
      );
      return;
    }
  }
  if (inventoryLimited) {
    result.issues.push({
      code: "caller-visible-inventory",
      severity: "info",
      message:
        "This preview covers only automations visible to this caller. A global primary preview is not a Gateway-wide inventory; other conversations or accounts may be omitted.",
    });
  }
  respond(true, result, undefined);
};
