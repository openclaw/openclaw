import { formatCliCommand } from "../cli/command-format.js";
import { note } from "../terminal/note.js";

const DEFAULT_DOCTOR_CONTRIBUTION_TIMEOUT_MS = 12_000;

export type TimedDoctorContribution<TContext> = {
  id: string;
  option: { label: string };
  run: (ctx: TContext) => Promise<void>;
};

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
    case "doctor:gateway-services":
      return 15_000;
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
): Promise<void> {
  const timeoutMs = resolveDoctorContributionTimeoutMs(contribution.id);
  onDebug?.(`contribution:start:${contribution.id}`);
  let timer: NodeJS.Timeout | undefined;

  await Promise.race([
    contribution.run(ctx),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new DoctorContributionTimeoutError(contribution.id, timeoutMs));
      }, timeoutMs);
      timer.unref?.();
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
      if (timer) {
        clearTimeout(timer);
      }
    });
}
