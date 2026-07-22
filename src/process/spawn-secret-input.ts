import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import type { SpawnSecretInput } from "./supervisor/types.js";

export type SpawnStdioEntry = "ignore" | "inherit" | "overlapped" | "pipe";

export function addSecretInputStdio(
  stdio: SpawnStdioEntry[],
  secretInput: SpawnSecretInput | undefined,
): void {
  if (!secretInput) {
    return;
  }
  if (!Number.isInteger(secretInput.fd) || secretInput.fd < 3) {
    throw new Error("secret input file descriptor must be an integer greater than 2");
  }
  while (stdio.length <= secretInput.fd) {
    stdio.push("ignore");
  }
  stdio[secretInput.fd] = process.platform === "win32" ? "overlapped" : "pipe";
}

export async function writeSecretInputToChild(
  child: ChildProcess,
  secretInput: SpawnSecretInput | undefined,
): Promise<void> {
  if (!secretInput) {
    return;
  }
  const stream = child.stdio[secretInput.fd] as Writable | null | undefined;
  if (!stream || typeof stream.end !== "function") {
    throw new Error(`secret input file descriptor ${secretInput.fd} is unavailable`);
  }
  let data: Buffer | undefined;
  try {
    data = secretInput.createData();
    // End the parent pipe immediately after delivery so descendants cannot
    // inherit a still-readable credential stream.
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        stream.off("error", onError);
        reject(error);
      };
      stream.once("error", onError);
      stream.end(data, () => {
        stream.off("error", onError);
        resolve();
      });
    });
  } finally {
    data?.fill(0);
  }
}
