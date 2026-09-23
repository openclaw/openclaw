// Client-side trigger script loading for cron create/edit commands.
import { createReadStream } from "node:fs";
import {
  readByteStreamWithLimit,
  type ReadByteStreamWithLimitOptions,
} from "@openclaw/media-core/read-byte-stream-with-limit";
import { CRON_JOB_SCRATCH_MAX_BYTES } from "../../cron/scratch-contract.js";
import { isErrno } from "../../infra/errno.js";
import { CronCliError } from "./cron-cli-error.js";

const MAX_CRON_TRIGGER_SCRIPT_BYTES = 65_536;

async function readCronInput(
  source: string,
  stdin: AsyncIterable<unknown> | undefined,
  options: ReadByteStreamWithLimitOptions,
): Promise<Buffer> {
  const stream = source === "-" ? (stdin ?? process.stdin) : createReadStream(source);
  try {
    return await readByteStreamWithLimit(stream, options);
  } catch (error) {
    // Filesystem read failures are operator input errors; byte-stream contract
    // violations and other unexpected exceptions keep their original identity.
    if (
      error instanceof Error &&
      isErrno(error) &&
      typeof error.errno === "number" &&
      typeof error.syscall === "string"
    ) {
      throw new CronCliError(error);
    }
    throw error;
  }
}

async function readScriptStream(
  source: string,
  stdin: AsyncIterable<unknown> | undefined,
  label: string,
): Promise<string> {
  const bytes = await readCronInput(source, stdin, {
    maxBytes: MAX_CRON_TRIGGER_SCRIPT_BYTES,
    onOverflow: () => new CronCliError(`${label} exceeds ${MAX_CRON_TRIGGER_SCRIPT_BYTES} bytes`),
  });
  return bytes.toString("utf8");
}

/** Reads a trigger script locally before sending the cron RPC. */
export async function readCronTriggerScript(
  source: string,
  deps?: {
    stdin?: AsyncIterable<unknown>;
  },
): Promise<string> {
  const raw = await readScriptStream(source, deps?.stdin, "Trigger script");
  const script = raw.trim();
  if (!script) {
    throw new CronCliError("Trigger script must not be empty");
  }
  return script;
}

/** Reads a script payload locally before sending the cron RPC. */
export async function readCronPayloadScript(
  source: string,
  deps?: { stdin?: AsyncIterable<unknown> },
): Promise<string> {
  const raw = await readScriptStream(source, deps?.stdin, "Script payload");
  const script = raw.trim();
  if (!script) {
    throw new CronCliError("Script payload must not be empty");
  }
  return script;
}

/** Reads exact scratch content locally; empty content is a meaningful value. */
export async function readCronScratchContent(
  source: string,
  deps?: { stdin?: AsyncIterable<unknown> },
): Promise<string> {
  const bytes = await readCronInput(source, deps?.stdin, {
    maxBytes: CRON_JOB_SCRATCH_MAX_BYTES,
    onOverflow: () => new CronCliError(`Cron scratch exceeds ${CRON_JOB_SCRATCH_MAX_BYTES} bytes`),
  });
  return bytes.toString("utf8");
}
