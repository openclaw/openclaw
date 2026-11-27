import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveGatewayService, type GatewayService } from "../../daemon/service.js";
import {
  verifyUpdateStateConsistency,
  type UpdateStateVerification,
} from "../../infra/update-data-at-risk.js";
import {
  dataAtRiskVerifiedStep,
  listUnverifiedDataAtRisk,
} from "../../infra/update-run-data-at-risk.js";
import { listUpdateRunsAsync, recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import { confirmGatewayReachable } from "../daemon-cli/restart-health-probe.js";
import {
  readGatewayServiceStateForUpdate,
  resolveUpdatedGatewayRestartPort,
} from "./update-command-service-plan.js";

export type ObservedGateway = { running?: boolean; version?: string };

/** Observe the Gateway when guidance is printed; a failed read is reported as unknown. */
export async function observeGatewayForGuidance(params: {
  service: GatewayService;
  env: NodeJS.ProcessEnv;
  config?: OpenClawConfig;
  timeoutMs?: number;
}): Promise<ObservedGateway> {
  try {
    const state = await readGatewayServiceStateForUpdate(
      params.service,
      params.env,
      params.timeoutMs,
    );
    if (!state.running) {
      // Only a confirmed stop is reported as stopped; an unreadable runtime stays unknown.
      return state.runtime?.status === "stopped" ? { running: false } : {};
    }
    const port = await resolveUpdatedGatewayRestartPort({
      config: params.config,
      serviceEnv: state.env,
      serviceCommand: state.command,
    });
    const reachability = await confirmGatewayReachable({
      port,
      config: params.config,
      env: state.env,
      timeoutMs: Math.min(params.timeoutMs ?? 3_000, 3_000),
    }).catch(() => undefined);
    return { running: true, version: reachability?.gatewayVersion ?? undefined };
  } catch {
    return {};
  }
}

function describeGateway(gateway: ObservedGateway): string {
  if (gateway.running === true) {
    return gateway.version
      ? `The Gateway is running and serving OpenClaw ${gateway.version}.`
      : "The Gateway is running.";
  }
  return gateway.running === false
    ? "The Gateway is stopped."
    : "The Gateway state could not be read.";
}

type Marks = readonly { runId: string; mark: string }[];

/** The newest mark by name; earlier ones by count, so one line covers them all. */
function describeMarks(marks: Marks): string {
  const [newest] = marks;
  const earlier = marks.length - 1;
  return `Update ${newest?.runId} recorded data at risk (${newest?.mark})${earlier ? ` and ${earlier} earlier update${earlier === 1 ? "" : "s"} did too` : ""}`;
}

export function formatDataAtRiskResolved(params: {
  marks: Marks;
  verification: Extract<UpdateStateVerification, { status: "consistent" }>;
}): string {
  return `${describeMarks(params.marks)}; verification found the ${params.verification.detail}, so ${params.marks.length === 1 ? "that mark is" : "those marks are"} resolved.`;
}

/** Agent first, then the manual command, for a finding a person must act on. */
export function formatDataAtRiskNextSteps(
  verification: Exclude<UpdateStateVerification, { status: "consistent" }>,
  env: NodeJS.ProcessEnv,
): string {
  return `Run \`${formatCliCommand("openclaw triage", env)}\` for an agent with the recorded facts, or by hand: ${verification.nextAction}`;
}

export function formatDataAtRiskRefusal(params: {
  marks: Marks;
  verification: Exclude<UpdateStateVerification, { status: "consistent" }>;
  gateway: ObservedGateway;
  /** What this command left as it was, then what to do next. */
  outcome: string;
}): string {
  const { verification } = params;
  const finding =
    verification.status === "unverifiable"
      ? `Could not verify: ${verification.detail}.`
      : `Found: ${verification.detail}.`;
  // Next steps come before the finding: a recorded warning keeps only its first 500 characters.
  return `${describeMarks(params.marks)}. ${describeGateway(params.gateway)} ${params.outcome} ${finding}`;
}

/**
 * Before a plain update creates its run: verify every unverified data-at-risk mark.
 * Consistent: report one line and return the recorder for the receipts on the new run.
 * Newer state or an unreadable database: warn and continue, since the update's own
 * schema checks still guard activation and updating is the named fix. Unchecked
 * rollback leftovers and any other finding refuse once its run exists, so the finding
 * is recorded; nothing changes.
 */
export async function verifyRecordedDataAtRiskBeforeUpdate(
  env: NodeJS.ProcessEnv,
  timeoutMs: number | undefined,
): Promise<((runId: string) => void) | undefined> {
  // The admitted worker reads history without a cold snapshot of a busy live database.
  const marks = listUnverifiedDataAtRisk(
    await listUpdateRunsAsync({ limit: 100 }, { env }, { current: true }),
  );
  if (marks.length === 0) {
    return undefined;
  }
  const verification = await verifyUpdateStateConsistency({
    env,
    formatCommand: (command) => formatCliCommand(command, env),
    marks,
  });
  if (verification.status === "consistent") {
    const detail = formatDataAtRiskResolved({ marks, verification });
    defaultRuntime.error(detail);
    return (runId) => {
      for (const marked of marks) {
        recordUpdateRunStep(
          runId,
          {
            step: dataAtRiskVerifiedStep(marked.runId),
            status: "completed",
            endedAtMs: Date.now(),
            detail,
          },
          { env },
        );
      }
    };
  }
  // Unchecked rollback leftovers stop the update: it restarts the Gateway.
  const continues =
    !verification.leftoversUnchecked &&
    (verification.status === "unverifiable" || verification.newerState === true);
  const refusal = formatDataAtRiskRefusal({
    marks,
    verification,
    gateway: await observeGatewayForGuidance({ service: resolveGatewayService(), env, timeoutMs }),
    outcome: continues
      ? "The update continues; its own checks still guard activation."
      : `The update changed nothing. ${formatDataAtRiskNextSteps(verification, env)}`,
  });
  if (continues) {
    defaultRuntime.error(`Warning: ${refusal}`);
    return undefined;
  }
  // The refusal is recorded on the new run, so an agent reading it has the finding.
  return (runId) => {
    recordUpdateRunStep(
      runId,
      {
        step: "data-at-risk verification",
        status: "failed",
        endedAtMs: Date.now(),
        detail: refusal,
      },
      { env },
    );
    throw new Error(refusal);
  };
}
