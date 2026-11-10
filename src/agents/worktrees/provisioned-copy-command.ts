import childProcess from "node:child_process";
import { hasErrnoCode } from "../../infra/errno.js";
import type { ProvisionCopyDetails } from "../../infra/fs-safe-copy-worker-contract.js";

// Only descriptor numbers cross stdin. FD 3 pins the parent's procfs descriptor table.
// Forking cp here avoids copying the large Gateway's page tables for every batch.
const command = `test -d "/proc/self/fd/3/$1" || exit 77
version=$(cp --version 2>/dev/null) || exit 78
case "$version" in 'cp (GNU coreutils)'*) ;; *) exit 78 ;; esac
printf R
while IFS= read -r target; do
  IFS= read -r sources || exit 1
  set --
  for source in $sources; do set -- "$@" "/proc/self/fd/3/$source"; done
  cp -L --reflink=auto --preserve=timestamps -t "/proc/self/fd/3/$target" "$@" || exit
  printf '.'
done`;

export function createProvisionCopyCommand(
  procFd: number,
  sourceFd: number,
  details?: ProvisionCopyDetails,
) {
  const spawnStarted = performance.now();
  const child = childProcess.spawn("/bin/sh", ["-c", command, "provision-copy", String(sourceFd)], {
    stdio: ["pipe", "pipe", "pipe", procFd],
  });
  if (details) {
    details.spawnCount++;
    details.spawnMs += performance.now() - spawnStarted;
  }
  const stdin = child.stdin!;
  const stdout = child.stdout!;
  const stderrStream = child.stderr!;
  let failure: Error | undefined;
  let exitCode: number | null | undefined;
  let stderr = "";
  stderrStream.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(0, 8192);
  });
  child.once("error", (error) => {
    failure = error;
  });
  stdin.on("error", (error) => {
    failure ??= error;
    stdin.end();
  });
  const closed = new Promise<void>((resolve) => {
    child.once("close", (code) => {
      exitCode = code;
      if (code !== 0) {
        failure ??= new Error(`Provisioning copy failed (${code}): ${stderr}`);
      }
      resolve();
    });
  });
  const output = stdout[Symbol.asyncIterator]();
  const receive = async (expected: string) => {
    try {
      const result = await output.next();
      if (!result.done && result.value.toString() === expected) {
        return;
      }
      throw new Error("Provisioning copy returned no batch receipt");
    } catch (error) {
      // A failed pipe is not settlement: cp may still hold the staging directory.
      stdin.end();
      await closed;
      throw failure ?? error;
    }
  };
  return {
    async ready() {
      try {
        await receive("R");
        return undefined;
      } catch (error) {
        if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "EACCES")) {
          return "helper-unavailable" as const;
        }
        if (exitCode === 77) {
          return "proc-descriptors-unavailable" as const;
        }
        if (exitCode === 78) {
          return "gnu-cp-unavailable" as const;
        }
        throw error;
      }
    },
    async copy(target: number, sources: readonly number[]) {
      const started = performance.now();
      if (details) {
        details.batchCount++;
      }
      try {
        stdin.write(`${target}\n${sources.join(" ")}\n`);
        await receive(".");
      } finally {
        if (details) {
          details.childMs += performance.now() - started;
        }
      }
    },
    async close() {
      stdin.end();
      await closed;
    },
  };
}
