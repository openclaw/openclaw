/** Local recovery retirement. This handler never invokes update or Doctor repair. */
import { confirm } from "@clack/prompts";
import {
  collectUpdateCleanupInventory,
  inspectSessionSqliteRecovery,
  type RecoveryCleanupReport,
} from "../../commands/doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "../../commands/doctor-session-sqlite-retirement.js";
import { selectUnmanifestedRecovery } from "../../commands/update-cleanup-unmanifested.js";
import { readConfigFileSnapshot, readSourceConfigBestEffort } from "../../config/io.js";
import { formatDurationHuman } from "../../infra/format-time/format-duration.js";
import { defaultRuntime, ExitError, writeRuntimeJson } from "../../runtime.js";
import { updateMaintenanceError } from "./update-maintenance-error.js";

function renderCleanup(report: RecoveryCleanupReport): void {
  defaultRuntime.log(`Recovery cleanup: ${report.stateDir}`);
  if (report.missingOriginals > 0) {
    defaultRuntime.log(
      `Missing recovery originals: ${report.missingOriginals} (historical receipts retained; no bytes on disk).`,
    );
  }
  for (const item of report.artifacts) {
    const age = item.modifiedAt
      ? `; modified ${formatDurationHuman(Math.max(0, Date.now() - Date.parse(item.modifiedAt)))} ago`
      : "";
    defaultRuntime.log(
      `  ${item.outcome}: ${item.path} (${item.bytes} bytes${age}; ${item.reason})${item.detail ? ` ${item.detail}` : ""}`,
    );
    if (item.consequence && item.outcome === "candidate") {
      defaultRuntime.log(`    ${item.consequence}`);
    }
  }
  defaultRuntime.log(
    `Candidates: ${report.totals.candidateBytes} bytes; verification required: ${report.totals.verificationRequiredBytes}; protected: ${report.totals.protectedBytes}; blocked: ${report.totals.blockedBytes}.`,
  );
  const captures = report.artifacts.filter((item) => item.kind === "update-capture");
  if (captures.length > 0) {
    const sum = (outcome?: string) =>
      captures
        .filter((item) => outcome === undefined || item.outcome === outcome)
        .reduce((bytes, item) => bytes + item.bytes, 0);
    defaultRuntime.log(
      `Update captures: ${captures.length} (${sum()} bytes); candidates: ${sum("candidate")} bytes; protected: ${sum("protected")} bytes.`,
    );
  }
  defaultRuntime.log(
    "Retiring originals permanently loses rollback, including pre-repair branches and metadata. Logical bytes are not a promise of physical space reclaimed.",
  );
  if (report.artifacts.length === 0) {
    defaultRuntime.log("No recorded recovery artifacts found.");
  }
  if (report.status === "complete") {
    defaultRuntime.log(
      `Removed ${report.totals.removedFiles} files (${report.totals.removedBytes} logical bytes).`,
    );
  }
}

export async function updateCleanupCommand(options: {
  dryRun?: boolean;
  json?: boolean;
  yes?: boolean;
  includeUnmanifested?: string[];
}): Promise<void> {
  let report: RecoveryCleanupReport | undefined;
  try {
    const readConfig = options.includeUnmanifested?.length
      ? async () => {
          const snapshot = await readConfigFileSnapshot({
            observe: false,
            pluginValidation: "core-only",
          });
          if (!snapshot.valid) {
            throw new Error(
              "Cannot include unmanifested recovery: configuration and includes must resolve successfully before selection or removal.",
            );
          }
          return snapshot.sourceConfig;
        }
      : readSourceConfigBestEffort;
    const cfg = await readConfig();
    if (options.includeUnmanifested?.length) {
      const inventory = collectUpdateCleanupInventory({ cfg, env: process.env });
      selectUnmanifestedRecovery({
        inventory,
        cfg,
        env: process.env,
        paths: options.includeUnmanifested,
      });
      report = inventory.report;
    } else {
      report = inspectSessionSqliteRecovery({ cfg, env: process.env });
    }
    if (!options.dryRun) {
      if (report.artifacts.length === 0 && !options.yes) {
        report.status = "complete";
      } else if (!options.yes && (options.json || !process.stdin.isTTY || !process.stderr.isTTY)) {
        report.status = "refused";
      } else {
        report = await retireSessionSqliteRecovery({
          env: process.env,
          preview: report,
          includeUnmanifested: options.includeUnmanifested,
          readConfig,
          onProgress: ({ phase, path, index, total, bytes }) => {
            const label = {
              verifying: "Verifying original",
              claiming: "Retiring original",
              "removing-capture": "Removing capture",
              "removing-unmanifested": "Retiring explicitly selected original",
            }[phase];
            process.stderr.write(`${label} ${index}/${total}: ${path} (${bytes} bytes)\n`);
          },
          confirm: async (verified) => {
            if (options.yes || verified.artifacts.length === 0) {
              return true;
            }
            renderCleanup(verified);
            const answer = await confirm({
              message: "Permanently retire these rollback originals?",
              initialValue: false,
              output: process.stderr,
            });
            return answer === true;
          },
        });
      }
    }
    if (options.json) {
      writeRuntimeJson(defaultRuntime, {
        ...report,
        artifacts: report.artifacts.map((item) =>
          item.modifiedAt
            ? { ...item, ageMs: Math.max(0, Date.now() - Date.parse(item.modifiedAt)) }
            : item,
        ),
        dryRun: options.dryRun === true,
      });
    } else {
      renderCleanup(report);
    }
    if (report.status === "refused") {
      defaultRuntime.error(
        "Nothing removed. Review with `openclaw update cleanup --dry-run`; use --yes to acknowledge permanent rollback loss.",
      );
      defaultRuntime.exit(1);
    } else if (report.status === "blocked") {
      defaultRuntime.exit(1);
    }
  } catch (error) {
    // Refusal and blocked outcomes were already rendered above.
    if (error instanceof ExitError) {
      throw error;
    }
    const message = String(updateMaintenanceError(error));
    if (options.json) {
      writeRuntimeJson(defaultRuntime, { ...report, status: "blocked", error: message });
    } else {
      defaultRuntime.error(message);
    }
    defaultRuntime.exit(1);
  }
}
