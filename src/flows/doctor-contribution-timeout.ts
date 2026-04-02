import { formatCliCommand } from "../cli/command-format.js";
import { note } from "../terminal/note.js";

const DEFAULT_DOCTOR_CONTRIBUTION_TIMEOUT_MS = 12_000;

export type TimedDoctorContribution<TContext> = {
  id: string;
  option: { label: string };
  run: (ctx: TContext) => Promise<void>;
};

type DoctorContributionTimeoutScheduler = (
  onTimeout: () => void,
  timeoutMs: number,
) => () => void;

type RunDoctorContributionWithTimeoutOptions = {
  timeoutMs?: number;
  scheduleTimeout?: DoctorContributionTimeoutScheduler;
};

function scheduleDoctorContributionTimeout(
  onTimeout: () => void,
  timeoutMs: number,
): () => void {
  const timer = setTimeout(onTimeout, timeoutMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export function resolveDoctorContributionTimeoutMs(id: string): number {
  const override = Number.parseInt(
    process.env.OPENCLAW_DOCTOR_CONTRIBUTION_TIMEOUT_MS ?? "",
    10,
  );
  if (Number.isFinite(override) && override > 0) {
    return override;
  }

  switch (id) {
    case "doctor:gateway-health":
    case "doctor:gateway-daemon":
      return 15_000;
    case "doctor:gateway-services":
      // Gateway services can fan out into several sequential WSL probes on
      // healthy-but-slow Windows hosts, so give the bounded diagnostics path
      // enough room to finish without misclassifying it as a doctor timeout.
      return 25_000;
    case "doctor:shell-completion":
    case "doctor:browser":
      return 8_000;
    default:
      return DEFAULT_DOCTOR_CONTRIBUTION_TIMEOUT_MS;
  }
}

export class DoctorContributionTimeoutError extends Error {
  constructor(
    readonly contributionId: string,
    readonly timeoutMs: number,
  ) {
    super(`Doctor step timed out after ${timeoutMs}ms.`);
    this.name = "DoctorContributionTimeoutError";
  }
}

export async function runDoctorContributionWithTimeout<TContext>(
  contribution: TimedDoctorContribution<TContext>,
  ctx: TContext,
  onDebug?: (message: string) => void,
  options?: RunDoctorContributionWithTimeoutOptions,
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? resolveDoctorContributionTimeoutMs(contribution.id);
  const scheduleTimeout = options?.scheduleTimeout ?? scheduleDoctorContributionTimeout;
  onDebug?.(`contribution:start:${contribution.id}`);
  let cancelTimeout = () => {};

  await Promise.race([
    contribution.run(ctx),
    new Promise((_, reject) => {
      cancelTimeout = scheduleTimeout(() => {
        reject(new DoctorContributionTimeoutError(contribution.id, timeoutMs));
      }, timeoutMs);
    }),
  ])
    .then(() => {
      onDebug?.(`contribution:done:${contribution.id}`);
    })
    .catch((error) => {
      if (!(error instanceof DoctorContributionTimeoutError)) {
        throw error;
      }
      onDebug?.(`contribution:timeout:${contribution.id}`);
      note(
        [
          `${contribution.option.label} timed out after ${Math.ceil(timeoutMs / 1000)}s.`,
          `Continue with the remaining doctor checks, then rerun ${formatCliCommand("openclaw doctor --non-interactive")} for a bounded retry.`,
          `If this keeps happening, inspect ${formatCliCommand("openclaw gateway status --json")} and the gateway logs before retrying.`,
        ].join("\n"),
        "Doctor timeout",
      );
    })
    .finally(() => {
      cancelTimeout();
    });
}
