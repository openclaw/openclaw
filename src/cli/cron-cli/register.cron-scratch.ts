import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
// Cron scratch CLI: private per-job prompt context reads and compare-and-swap writes.
import type { Command } from "commander";
import type {
  CronScratchGetResult,
  CronScratchSetResult,
} from "../../../packages/gateway-protocol/src/schema/cron.types.js";
import { CRON_JOB_SCRATCH_MAX_BYTES } from "../../cron/scratch-contract.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import { CronCliError } from "./cron-cli-error.js";
import { createCronOutputCommand } from "./output-mode.js";
import { handleCronCliError, printCronJson, requireCronJobId } from "./shared.js";
import { readCronScratchContent } from "./trigger-options.js";

function parseExpectedRevision(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const revision = parseStrictNonNegativeInteger(value);
  if (revision === undefined) {
    throw new CronCliError("--expected-revision must be a non-negative integer");
  }
  return revision;
}

export function registerCronScratchCommand(cron: Command) {
  addGatewayClientOptions(
    createCronOutputCommand(cron, "scratch")
      .description("Read or replace an automation's private scratch")
      .argument("<id>", "Job id")
      .option("--set <text>", "Replace scratch with exact text")
      .option("--file <path>", "Replace scratch from a file, or - for stdin")
      .option("--unset", "Remove the scratch row", false)
      .option("--expected-revision <n>", "Require the current scratch revision")
      .action(async (idArg, opts) => {
        try {
          const id = requireCronJobId(idArg);
          const mutations = [
            opts.set !== undefined,
            opts.file !== undefined,
            opts.unset === true,
          ].filter(Boolean).length;
          if (mutations > 1) {
            throw new CronCliError("choose only one of --set, --file, or --unset");
          }
          // Inline writes with a valid explicit revision already have their CAS input.
          // Keep the initial read before file/stdin consumption and input errors.
          let expectedRevision =
            mutations === 1 &&
            opts.expectedRevision !== undefined &&
            opts.file === undefined &&
            (opts.unset ||
              Buffer.byteLength(String(opts.set ?? ""), "utf8") <= CRON_JOB_SCRATCH_MAX_BYTES)
              ? parseStrictNonNegativeInteger(opts.expectedRevision)
              : undefined;
          if (expectedRevision === undefined) {
            const current = (await callGatewayFromCli("cron.scratch.get", opts, {
              id,
            })) as CronScratchGetResult;
            if (mutations === 0) {
              if (opts.json) {
                printCronJson(current);
              } else if (current.scratch) {
                process.stdout.write(current.scratch.content);
              }
              return;
            }
            expectedRevision =
              parseExpectedRevision(opts.expectedRevision) ?? current.currentRevision;
          }

          const content = opts.unset
            ? null
            : opts.file !== undefined
              ? await readCronScratchContent(String(opts.file))
              : String(opts.set ?? "");
          const result = (await callGatewayFromCli("cron.scratch.set", opts, {
            id,
            content,
            expectedRevision,
          })) as CronScratchSetResult;
          if (!result.ok) {
            throw new CronCliError(
              `cron scratch changed concurrently (current revision ${result.currentRevision})`,
            );
          }
          printCronJson(result);
        } catch (error) {
          handleCronCliError(error);
        }
      }),
  );
}
