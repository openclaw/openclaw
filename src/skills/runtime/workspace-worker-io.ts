import type { Writable } from "node:stream";

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

export async function writeSkillWorkerResult(output: Writable, value: unknown): Promise<void> {
  // Native discovery and change metadata are not Skill Library resource bundles.
  // Preserve their existing sizes and wait for the stream before the child exits.
  await new Promise<void>((resolve, reject) => {
    output.write(`${JSON.stringify(value)}\n`, (error) => (error ? reject(error) : resolve()));
  });
}
