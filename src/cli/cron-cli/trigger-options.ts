// Client-side trigger script loading for cron create/edit commands.
import fs from "node:fs/promises";

const MAX_CRON_TRIGGER_SCRIPT_BYTES = 65_536;

async function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_CRON_TRIGGER_SCRIPT_BYTES) {
      throw new Error("Trigger script exceeds 65536 bytes");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

/** Reads a trigger script locally before sending the cron RPC. */
export async function readCronTriggerScript(
  source: string,
  deps?: {
    readFile?: (path: string) => Promise<string>;
    stdin?: NodeJS.ReadableStream;
  },
): Promise<string> {
  const raw =
    source === "-"
      ? await readStdin(deps?.stdin ?? process.stdin)
      : await (deps?.readFile ?? ((path) => fs.readFile(path, "utf8")))(source);
  if (Buffer.byteLength(raw, "utf8") > MAX_CRON_TRIGGER_SCRIPT_BYTES) {
    throw new Error("Trigger script exceeds 65536 bytes");
  }
  const script = raw.trim();
  if (!script) {
    throw new Error("Trigger script must not be empty");
  }
  return script;
}
