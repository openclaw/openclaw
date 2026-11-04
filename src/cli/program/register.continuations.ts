// Continuation (karmaterminal): the offline fence drain over durable continue_work custody
// (docs/design/continue-work-signal-v2.md §5.4.2). Both commands refuse while a Gateway owns the
// state, so no wake's turn is in flight while they read or end records.
import type { Command } from "commander";
import { resolveStateDir } from "../../config/paths.js";
import { defaultRuntime, writeRuntimeJson, writeRuntimeStdout } from "../../runtime.js";
import { formatCliJsonFailure } from "../failure-output.js";
import { runWithLocalStateOwner } from "../local-state-owner.js";

type ContinuationsOutputOptions = { json?: boolean };

/** Exit 2: a Gateway or another state owner is running, or could not be ruled out. */
const EXIT_OWNER_REFUSED = 2;
/** The refusal code both commands report, the drain's through LocalStateOwnerError. */
const OWNER_UNAVAILABLE = "OWNER_UNAVAILABLE";

class ContinuationsStateOwnerRunningError extends Error {
  readonly code = OWNER_UNAVAILABLE;

  constructor(stateDir: string, cause?: unknown) {
    super(
      `openclaw continuations fence-status is offline-only: the state root ${stateDir} has a running owner (a Gateway or an embedded agent), or one that could not be ruled out. Nothing was read. Inspect openclaw gateway status; to count, stop the Gateway through its service owner, wait for ownership to release, then rerun this exact command.`,
      { cause },
    );
    this.name = "ContinuationsStateOwnerRunningError";
  }
}

function isOwnerRefusal(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error && error.code === OWNER_UNAVAILABLE;
}

/**
 * The count takes no lock: acquiring one reads the Gateway owner lease from the live store, which
 * opens it, and a cleanly stopped store would grow WAL sidecars. It refuses while discovery finds an
 * owner of the state root, then reads a private snapshot (the bootstrap's interlock keeps a Gateway
 * from starting in between).
 */
async function assertNoStateOwner(env: NodeJS.ProcessEnv): Promise<void> {
  const { readActiveGatewayLockIdentity } = await import("../../infra/gateway-lock.js");
  let owner: unknown;
  try {
    owner = await readActiveGatewayLockIdentity({
      env,
      includeEmbedded: true,
      requireInspection: true,
    });
  } catch (error) {
    throw new ContinuationsStateOwnerRunningError(resolveStateDir(env), error);
  }
  if (owner) {
    throw new ContinuationsStateOwnerRunningError(resolveStateDir(env));
  }
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
        await assertNoStateOwner(process.env);
        const status = await readContinuationFenceStatus(process.env);
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
        const receipt = await runWithLocalStateOwner({
          method: "continuations.interrupt-fenced",
          params: {},
          target: "openclaw continuations interrupt-fenced",
          onForeignOwner: "refuse",
          runLocal: () => drainUndeliveredTurnFences(),
        });
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
