// Client-side trigger script loading for cron create/edit commands.
import { realpath } from "node:fs/promises";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import { CRON_JOB_SCRATCH_MAX_BYTES } from "../../cron/scratch-contract.js";
import { isErrno } from "../../infra/errno.js";
import { FsSafeError, readRegularFile } from "../../infra/fs-safe.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { CronCliError } from "./cron-cli-error.js";

const MAX_CRON_TRIGGER_SCRIPT_BYTES = 65_536;

function decodeCronInput(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new CronCliError(`${label} must be valid UTF-8`, { cause: error });
  }
}

async function readCronInput(
  source: string,
  stdin: AsyncIterable<unknown> | undefined,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const onOverflow = () => new CronCliError(`${label} exceeds ${maxBytes} bytes`);
  const signal = getAsyncWorkSignal();
  let bytes: Buffer;
  try {
    if (source === "-") {
      bytes = await readByteStreamWithLimit(stdin ?? process.stdin, {
        maxBytes,
        onOverflow,
        signal,
      });
    } else {
      bytes = (await readRegularFile({ filePath: await realpath(source), maxBytes })).buffer;
    }
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "too-large") {
      throw onOverflow();
    }
    // File admission failures are operator errors; stdin contract violations
    // and unexpected stream exceptions keep their original identity.
    if (
      error instanceof Error &&
      (source !== "-" ||
        (isErrno(error) && typeof error.errno === "number" && typeof error.syscall === "string"))
    ) {
      throw new CronCliError(error);
    }
    throw error;
  }
  // Reject accepted cancellation that lands after the read but before the caller
  // turns the bytes into a cron mutation RPC.
  signal?.throwIfAborted();
  return bytes;
}

async function readScriptStream(
  source: string,
  stdin: AsyncIterable<unknown> | undefined,
  label: string,
): Promise<string> {
  const bytes = await readCronInput(source, stdin, MAX_CRON_TRIGGER_SCRIPT_BYTES, label);
  const script = decodeCronInput(bytes, label).trim();
  if (!script) {
    throw new CronCliError(`${label} must not be empty`);
  }
  return script;
}

/** Reads a trigger script locally before sending the cron RPC. */
export async function readCronTriggerScript(
  source: string,
  deps?: {
    stdin?: AsyncIterable<unknown>;
  },
): Promise<string> {
  return await readScriptStream(source, deps?.stdin, "Trigger script");
}

/** Reads a script payload locally before sending the cron RPC. */
export async function readCronPayloadScript(
  source: string,
  deps?: { stdin?: AsyncIterable<unknown> },
): Promise<string> {
  return await readScriptStream(source, deps?.stdin, "Script payload");
}

/** Reads exact scratch content locally; empty content is a meaningful value. */
export async function readCronScratchContent(
  source: string,
  deps?: { stdin?: AsyncIterable<unknown> },
): Promise<string> {
  const bytes = await readCronInput(
    source,
    deps?.stdin,
    CRON_JOB_SCRATCH_MAX_BYTES,
    "Cron scratch",
  );
  return decodeCronInput(bytes, "Cron scratch");
}
