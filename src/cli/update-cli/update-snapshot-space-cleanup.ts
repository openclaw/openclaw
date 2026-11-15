/** Offers retirable recovery copies when an update's space check would refuse. */
import {
  inspectSessionSqliteRecovery,
  type RecoveryCleanupReport,
} from "../../commands/doctor-session-sqlite-recovery-inventory.js";
import { retireOwnedSessionSqliteRecovery } from "../../commands/doctor-session-sqlite-retirement.js";
import { createConfigIO } from "../../config/io.js";
import { formatDiskSpaceBytes } from "../../infra/disk-space.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { runWithLocalStateOwner } from "../local-state-owner.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";

type CleanupOfferOptions = {
  json?: boolean;
  yes?: boolean;
  /** Mid-update checks only report; the offer runs before the update changes anything. */
  prompt?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Writes one line for the person running the update. */
  print: (line: string) => void;
};

/** Only a person at a terminal can approve removal; `--yes` keeps removal's default of no. */
export function canPromptForSpaceCleanup(options: { json?: boolean; yes?: boolean }): boolean {
  return !options.json && !options.yes && process.stdin.isTTY && process.stderr.isTTY;
}

function readCleanupConfig(env: NodeJS.ProcessEnv) {
  const io = createConfigIO({ env, observe: false, pluginValidation: "core-only" });
  return () => io.readSourceConfigBestEffort();
}

/** Removal goes to a running Gateway, which owns state until the update stops it. */
function retireRecoveryCopies(env: NodeJS.ProcessEnv): Promise<RecoveryCleanupReport> {
  return withOwnedManagedUpdateEnv(env, () =>
    runWithLocalStateOwner({
      method: "update.recovery.cleanup",
      params: { dryRun: false },
      target: "retirable update recovery copies",
      recoveryCommand: "openclaw update cleanup --dry-run",
      timeoutMs: 10 * 60_000,
      runLocal: async ({ env: selectedEnv, assertCurrent }) => {
        const readConfig = readCleanupConfig(selectedEnv);
        const preview = await inspectSessionSqliteRecovery({
          cfg: await readConfig(),
          env: selectedEnv,
        });
        assertCurrent();
        return retireOwnedSessionSqliteRecovery(
          { env: selectedEnv, preview, readConfig, confirm: async () => true },
          { assertCurrent },
        );
      },
    }),
  );
}

/**
 * Cleanup's own eligibility decides what may go; nothing is removed without an
 * interactive yes, so `--yes`, JSON and Gateway-driven updates only report it.
 */
export async function assessSnapshotCapacityOfferingCleanup(
  assess: () => Promise<UpdateStepResult>,
  options: CleanupOfferOptions,
): Promise<UpdateStepResult> {
  const result = await assess();
  if (result.exitCode === 0) {
    return result;
  }
  const env = options.env ?? process.env;
  let preview: RecoveryCleanupReport;
  try {
    preview = await inspectSessionSqliteRecovery({ cfg: await readCleanupConfig(env)(), env });
  } catch {
    // An unreadable inventory leaves the original refusal unchanged.
    return result;
  }
  const candidates = preview.artifacts.filter((item) => item.outcome === "candidate");
  if (candidates.length === 0 || preview.totals.candidateBytes <= 0) {
    return result;
  }
  const size = formatDiskSpaceBytes(preview.totals.candidateBytes);
  const summary = `${candidates.length} recovery ${candidates.length === 1 ? "copy" : "copies"} from earlier updates use ${size} and can be removed.`;
  if (options.prompt === false || !canPromptForSpaceCleanup(options)) {
    return {
      ...result,
      stderrTail: [
        result.stderrTail,
        `${summary} Run openclaw update in a terminal to be offered their removal, or stop the Gateway and run openclaw update cleanup, then retry.`,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  options.print(summary);
  for (const item of candidates) {
    options.print(`  ${item.path} (${formatDiskSpaceBytes(item.bytes)}; ${item.reason})`);
  }
  const { confirm, isCancel } = await import("@clack/prompts");
  const { stylePromptMessage } =
    await import("../../../packages/terminal-core/src/prompt-style.js");
  const answer = await confirm({
    message: stylePromptMessage(
      `Permanently remove these recovery copies (${size}) and check space again?`,
    ),
    initialValue: false,
    output: process.stderr,
  });
  if (isCancel(answer) || !answer) {
    return result;
  }
  try {
    const report = await retireRecoveryCopies(env);
    options.print(
      `Removed ${report.totals.removedFiles} recovery files (${formatDiskSpaceBytes(report.totals.removedBytes)}).`,
    );
  } catch (error) {
    options.print(`Recovery cleanup did not finish: ${formatErrorMessage(error)}`);
  }
  return assess();
}
