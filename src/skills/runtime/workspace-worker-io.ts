import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

const MAX_REQUEST_BYTES = 12 * 1024 * 1024;

// This is same-version subprocess IPC from the provisioned workspace adapter,
// not a network endpoint. Native Skills owners validate operation semantics;
// node/SSH adapters own authentication and the admitted filesystem roots.
export function decodeSkillWorkerRequest(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Skill worker request must be an object");
  }
  // SAFETY: JSON.parse returned a non-null, non-array object; every property stays unknown.
  return value as Record<string, unknown>;
}

export function skillWorkerLines(input: Readable) {
  let bytes = 0;
  let parsedBytes = 0;
  let overflow: Error | undefined;
  const count = (chunk: Buffer | string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_REQUEST_BYTES) {
      overflow = new Error("Skill publication exceeds its byte limit");
      input.destroy();
      lines.close();
    }
  };
  input.on("data", count);
  const lines = createInterface({ input, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  return {
    async read(): Promise<Record<string, unknown>> {
      const line = await iterator.next();
      if (overflow) {
        throw overflow;
      }
      if (line.done) {
        throw new Error("Skill publication transport closed");
      }
      parsedBytes += Buffer.byteLength(line.value) + 1;
      if (parsedBytes > MAX_REQUEST_BYTES) {
        throw new Error("Skill publication exceeds its byte limit");
      }
      return decodeSkillWorkerRequest(line.value);
    },
    close() {
      input.off("data", count);
      lines.close();
    },
  };
}

export async function writeSkillWorkerResult(output: Writable, value: unknown): Promise<void> {
  // Native discovery and change metadata are not Skill Library resource bundles.
  // Preserve their existing sizes and wait for the stream before the child exits.
  await new Promise<void>((resolve, reject) => {
    output.write(`${JSON.stringify(value)}\n`, (error) => (error ? reject(error) : resolve()));
  });
}
