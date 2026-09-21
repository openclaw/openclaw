import { sanitizeTriageUpdateFailure } from "../../commands/triage-update.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { hashConfigRaw } from "../../config/io.read-helpers.js";
import { resolveInstallationTarget } from "../../infra/installation-target-context.js";
import { readPackageVersion } from "../../infra/package-json.js";
import type { validateUpdateCandidateCanary } from "../../infra/update-candidate-canary.js";
import {
  prepareUpdateCandidateRehearsal,
  type UpdateCandidateRehearsal,
} from "../../infra/update-candidate-rehearsal.js";
import { prepareUnattendedUpdateRepair } from "../../infra/update-repair-agent.js";
import type {
  UpdateRepairEvent,
  UpdateRepairValidation,
} from "../../infra/update-repair-protocol.js";
import {
  resolveManagedUpdateRequester,
  UpdateRequesterRevokedError,
} from "../../infra/update-requester-authority.js";
import {
  getUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunRepairAttempt,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import type { UpdateCommandOptions } from "./shared.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";

export function updateRepairValidationFromCanary(
  validation: Awaited<ReturnType<typeof validateUpdateCandidateCanary>>,
): UpdateRepairValidation {
  return {
    ok: validation.status === "ok",
    score: validation.steps.filter((step) => step.exitCode === 0).length,
    summary: validation.status === "ok" ? "Update checks passed." : validation.logTail.join("\n"),
  };
}

export async function runUpdateCommandRepair(
  params: {
    root: string;
    env: NodeJS.ProcessEnv;
    run?: UpdateCommandOptions["run"];
    nodeRunner?: string;
    validate: (
      signal: AbortSignal,
      assertCurrent: () => void,
      rehearsal?: UpdateCandidateRehearsal,
    ) => Promise<UpdateRepairValidation>;
    onEvent?: (event: UpdateRepairEvent) => void;
  } & (
    | {
        phase: "validating";
        candidateRoot: string;
        mode: UpdateRunResult["mode"];
        validation: Extract<
          Awaited<ReturnType<typeof validateUpdateCandidateCanary>>,
          { status: "error" }
        >;
      }
    | { phase: "verifying"; result: UpdateRunResult }
  ),
) {
  const retained = params.phase === "validating" ? params.validation.retainedRehearsal : undefined;
  let cleanupUncertain = false;
  try {
    const candidateRoot = params.phase === "validating" ? params.candidateRoot : params.root;
    const result: UpdateRunResult =
      params.phase === "validating"
        ? {
            status: "error",
            mode: params.mode,
            root: candidateRoot,
            reason: params.validation.reason,
            before: { version: await readPackageVersion(params.root) },
            after: { version: await readPackageVersion(candidateRoot) },
            steps: params.validation.steps,
            durationMs: params.validation.durationMs,
          }
        : params.result;
    const target = resolveInstallationTarget(params.env);
    const options = {
      env: { ...(params.run?.env ?? params.env) },
      redactPaths: params.phase === "validating" ? [params.root, candidateRoot] : [params.root],
    };
    const runId = params.run?.runId;
    const admittedRun = runId ? getUpdateRun(runId, options) : undefined;
    const requester = resolveManagedUpdateRequester(admittedRun?.origin.requester);
    const requesterAuthority = params.run?.requesterAuthority;
    const isCurrent = () => {
      if ((requester && !requesterAuthority) || requesterAuthority?.isCurrent() === false) {
        throw new UpdateRequesterRevokedError();
      }
      return !runId || getUpdateRun(runId, options)?.status === "running";
    };
    const previousAttempts = admittedRun?.repair ?? [];
    const attemptOffset = Math.max(0, ...previousAttempts.map((attempt) => attempt.attempt));
    const startedAtMs = Date.now();
    let turnStartedAtMs = startedAtMs;
    let completedTurns = 0;
    let activeTurn = 0;
    let lastValidation: UpdateRepairValidation | undefined;
    const targetClass = params.phase === "validating" ? "update checks" : "installed version";
    if (runId) {
      recordUpdateRunPhase(
        runId,
        "repairing",
        { step: { step: "repairing", status: "in_progress", detail: targetClass } },
        options,
      );
    }
    return await withOwnedManagedUpdateEnv(params.env, async () => {
      let pending: Promise<UpdateRepairValidation> | undefined;
      let rehearsal = retained?.rehearsal;
      let initialValidation =
        params.phase === "validating" && retained
          ? updateRepairValidationFromCanary(params.validation)
          : undefined;
      try {
        if (params.phase === "validating" && !rehearsal) {
          // Failed migrations or unconfirmed child shutdown cannot supply reusable facts.
          const snapshot = await readConfigFileSnapshot({
            // Plugin metadata reads SQLite; materialize it only after binding the rehearsal.
            pluginValidation: "core-only",
            observe: false,
          });
          rehearsal = await prepareUpdateCandidateRehearsal({
            candidateRoot,
            config: snapshot.config,
            sourceConfigHash: hashConfigRaw(snapshot.raw),
            stateDir: target.stateDir,
            env: params.env,
            nodeRunner: params.nodeRunner,
          });
        }
        return await prepareUnattendedUpdateRepair({
          runId,
          requester: requesterAuthority?.requester,
          nodeRunner: params.nodeRunner,
          admissionEnv: options.env,
          target: {
            // Rehearsal state carries the candidate's schema, so the candidate must
            // host the repair. After activation that same owner is the replaced install.
            installRoot: candidateRoot,
            stateDir: rehearsal?.stateDir ?? target.stateDir,
            configPath: rehearsal?.configPath ?? target.configPath,
            workspaceDir: rehearsal?.workspaceDir ?? target.defaultWorkspaceDir,
            environment: rehearsal?.env,
          },
          context: {
            ...sanitizeTriageUpdateFailure(
              { result },
              { env: params.env, stateDir: target.stateDir },
            ),
            phase: params.phase,
            beforeVersion: result.before?.version ?? undefined,
            targetVersion: result.after?.version ?? undefined,
          },
          validate: (signal) => {
            const assertCurrent = () => {
              signal.throwIfAborted();
              if (!isCurrent()) {
                throw new Error("Repair no longer owns the update attempt.");
              }
            };
            assertCurrent();
            // These facts include Doctor's migrations in this exact private copy.
            // Consume once; every oracle after a repair turn must inspect its writes.
            const prepared = initialValidation;
            initialValidation = undefined;
            pending = (async () => {
              const validation =
                prepared ?? (await params.validate(signal, assertCurrent, rehearsal));
              assertCurrent();
              return validation;
            })();
            return pending;
          },
          isCurrent,
          onEvent: (event) => {
            if (event.type === "validation") {
              lastValidation = event.validation;
            }
            if (event.type === "turn-started") {
              turnStartedAtMs = Date.now();
              activeTurn = event.turn;
            }
            if (runId) {
              if (event.type === "turn-started" || event.type === "turn-finished") {
                recordUpdateRunStep(
                  runId,
                  {
                    step: `repair attempt ${attemptOffset + event.turn}`,
                    status:
                      event.type === "turn-started"
                        ? "in_progress"
                        : event.validation.ok
                          ? "completed"
                          : "failed",
                    startedAtMs: turnStartedAtMs,
                    ...(event.type === "turn-finished"
                      ? { endedAtMs: Date.now(), detail: event.summary }
                      : {}),
                  },
                  options,
                );
              }
              if (event.type === "turn-finished") {
                completedTurns += 1;
                recordUpdateRunRepairAttempt(
                  runId,
                  {
                    attempt: attemptOffset + event.turn,
                    status: event.validation.ok ? "succeeded" : "failed",
                    startedAtMs: turnStartedAtMs,
                    endedAtMs: Date.now(),
                    summary: `${event.provider}/${event.model}: ${event.validation.stopReason ? event.validation.summary : event.summary}`,
                    reason: event.validation.stopReason ?? event.validation.summary,
                  },
                  options,
                );
              }
              if (event.type === "stopped") {
                recordUpdateRunStep(
                  runId,
                  {
                    step: "repairing",
                    status:
                      event.status === "repaired"
                        ? "completed"
                        : event.status === "unavailable" && activeTurn === 0
                          ? "skipped"
                          : "failed",
                    endedAtMs: Date.now(),
                    detail: `${targetClass}: ${event.reason ?? event.status}${lastValidation?.stopReason ? ` — ${lastValidation.summary}` : ""}`,
                  },
                  options,
                );
                if (completedTurns === 0 || event.reason === "requester-revoked") {
                  recordUpdateRunRepairAttempt(
                    runId,
                    {
                      attempt: attemptOffset + Math.max(1, activeTurn),
                      status:
                        event.status === "repaired"
                          ? "succeeded"
                          : activeTurn
                            ? "failed"
                            : "skipped",
                      startedAtMs: activeTurn ? turnStartedAtMs : startedAtMs,
                      endedAtMs: Date.now(),
                      summary: lastValidation?.stopReason
                        ? lastValidation.summary
                        : (event.reason ?? event.status),
                      reason: event.reason,
                    },
                    options,
                  );
                }
              }
            }
            params.onEvent?.(event);
          },
        });
      } catch (error: unknown) {
        cleanupUncertain = hasCommandProcessCleanupError(error);
        throw error;
      } finally {
        // Cancellation must drain the oracle before its caller activates or discards
        // a candidate, or restores the installation environment.
        await pending?.catch((error: unknown) => {
          if (!cleanupUncertain && hasCommandProcessCleanupError(error)) {
            throw error;
          }
        });
        if (!cleanupUncertain && !retained) {
          await rehearsal?.cleanup();
        }
      }
    });
  } catch (error: unknown) {
    cleanupUncertain ||= hasCommandProcessCleanupError(error);
    throw error;
  } finally {
    if (!cleanupUncertain) {
      await retained?.cleanup();
    }
  }
}
