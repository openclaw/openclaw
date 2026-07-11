import type { Readable } from "node:stream";
import {
  prepareSystemRunApproval,
  type SystemRunPrepareParams,
} from "../../node-host/system-run-prepare.js";

const MAX_INPUT_BYTES = 1024 * 1024;

async function readBoundedInput(input: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_INPUT_BYTES) {
      throw new Error("system.run.prepare input exceeds 1 MiB");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runNodePrepareSystemRun(input: Readable = process.stdin): Promise<string> {
  const raw = await readBoundedInput(input);
  const params = JSON.parse(raw) as unknown;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("system.run.prepare input must be a JSON object");
  }
  const result = await prepareSystemRunApproval(params as SystemRunPrepareParams);
  if (!result.ok) {
    throw new Error(result.message);
  }
  return JSON.stringify({
    plan: result.plan,
    allowAlwaysCoverage: result.allowAlwaysCoverage,
  });
}
