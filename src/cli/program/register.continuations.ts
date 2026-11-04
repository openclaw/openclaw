// Continuation (karmaterminal): the offline fence drain over durable continue_work custody
// (docs/design/continue-work-signal-v2.md §5.4.2). Both commands refuse while a Gateway owns the
// state, so no wake's turn is in flight while they read or end records.
import type { Command } from "commander";
import { defaultRuntime, writeRuntimeJson, writeRuntimeStdout } from "../../runtime.js";
import { formatCliJsonFailure } from "../failure-output.js";
import { runWithLocalStateOwner } from "../local-state-owner.js";

type ContinuationsOutputOptions = { json?: boolean };

/** Exit 2: offline ownership was refused (a Gateway or another state owner is running). */
const EXIT_OWNER_REFUSED = 2;

function isOwnerRefusal(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    error.name === "LocalStateOwnerError" &&
    "code" in error &&
    error.code === "OWNER_UNAVAILABLE"
  );
}

function writeContinuationsError(error: unknown, json: boolean): void {
  const refused = isOwnerRefusal(error);
  if (json) {
    const failure = formatCliJsonFailure(error);
    writeRuntimeJson(
      defaultRuntime,
      refused ? { ...failure, error: { ...failure.error, code: error.code } } : failure,
    );
  } else {
    defaultRuntime.error(error instanceof Error ? error.message : String(error));
  }
  defaultRuntime.exit(refused ? EXIT_OWNER_REFUSED : 1);
}

function runOffline<T>(
  command: "fence-status" | "interrupt-fenced",
  run: (scope: { env: NodeJS.ProcessEnv; assertCurrent: () => void }) => Promise<T>,
): Promise<T> {
  return runWithLocalStateOwner({
    method: `continuations.${command}`,
    params: {},
    target: `openclaw continuations ${command}`,
    databaseEngine: "configured",
    onForeignOwner: "refuse",
    runLocal: async ({ env, assertCurrent }) => {
      const result = await run({ env, assertCurrent });
      assertCurrent();
      return result;
    },
  });
}

export function registerContinuationsCommand(program: Command): void {
  const continuations = program
    .command("continuations")
    .description("Inspect and drain durable continue_work custody while the Gateway is stopped");

  continuations
    .command("fence-status")
    .description(
      "Count continue_work wakes whose turn started but whose delivery was never confirmed (read-only, offline)",
    )
    .option("--json", "emit machine-readable JSON", false)
    .action(async (options: ContinuationsOutputOptions) => {
      try {
        const { readContinuationFenceStatus } =
          await import("../../auto-reply/continuation/work-fence-drain.js");
        const status = await runOffline("fence-status", ({ env }) =>
          readContinuationFenceStatus(env),
        );
        if (options.json) {
          writeRuntimeJson(defaultRuntime, status);
          return;
        }
        writeRuntimeStdout(
          defaultRuntime,
          [
            `Fenced, undelivered continue_work wakes: ${status.fencedUndelivered}`,
            ...status.records.map(
              (record) =>
                `  ${record.recordId} ${record.status} run ${record.runId} started ${new Date(record.startedAt).toISOString()}`,
            ),
            `Interrupted-turn notices still owed: ${status.owedInterruptNotices}`,
            ...status.owedNoticeRecordIds.map((recordId) => `  ${recordId}`),
            "",
          ].join("\n"),
        );
      } catch (error) {
        writeContinuationsError(error, options.json === true);
      }
    });

  continuations
    .command("interrupt-fenced")
    .description(
      "End each fenced, undelivered continue_work wake as interrupted with its one notice, as recovery does (offline; never runs a turn)",
    )
    .option("--json", "emit machine-readable JSON", false)
    .action(async (options: ContinuationsOutputOptions) => {
      try {
        const { drainUndeliveredTurnFences } =
          await import("../../auto-reply/continuation/work-fence-drain.js");
        const receipt = await runOffline("interrupt-fenced", () => drainUndeliveredTurnFences());
        if (options.json) {
          writeRuntimeJson(defaultRuntime, receipt);
          return;
        }
        writeRuntimeStdout(
          defaultRuntime,
          [
            `Interrupted ${receipt.interrupted} fenced, undelivered continue_work wakes; settled ${receipt.noticesSettled} notices.`,
            ...receipt.records.map(
              (record) =>
                `  ${record.recordId} ${record.status} notice ${record.noticeDeliveryId} (${record.noticeDeliveryStatus})`,
            ),
            "",
          ].join("\n"),
        );
      } catch (error) {
        writeContinuationsError(error, options.json === true);
      }
    });
}
