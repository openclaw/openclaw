import childProcess from "node:child_process";
import { createInterface } from "node:readline";
import { hasErrnoCode } from "../../infra/errno.js";
import type { ProvisionCopyDetails } from "../../infra/fs-safe-copy-worker-contract.js";

// Only descriptor numbers cross stdin. FD 3 pins the parent's procfs descriptor table.
// Forking cp here avoids copying the large Gateway's page tables for every batch.
const command = `test -d "/proc/self/fd/3/$1" || exit 77
version=$(cp --version 2>/dev/null) || exit 78
case "$version" in 'cp (GNU coreutils)'*) ;; *) exit 78 ;; esac
version=\${version#'cp (GNU coreutils) '}
version=\${version%%[!0-9.]*}
major=\${version%%.*}
minor=\${version#*.}
minor=\${minor%%.*}
debug=
if [ "$major" -gt 9 ] || { [ "$major" -eq 9 ] && [ "$minor" -ge 2 ]; }; then debug=--debug; fi
printf 'R\\n'
while IFS= read -r target; do
  IFS= read -r sources || exit 1
  set --
  for source in $sources; do set -- "$@" "/proc/self/fd/3/$source"; done
  LC_ALL=C cp $debug -L --reflink=auto --preserve=timestamps -t "/proc/self/fd/3/$target" "$@" || exit
  printf '.\\n'
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
  const output = createInterface({ input: stdout })[Symbol.asyncIterator]();
  const receive = async (expected: string, observe?: (line: string) => void) => {
    try {
      for (;;) {
        const result = await output.next();
        if (result.done) {
          break;
        }
        if (result.value === expected) {
          return;
        }
        observe?.(result.value);
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
    async copy(target: number, sources: readonly { fd: number; bytes: number }[]) {
      const started = performance.now();
      if (details) {
        details.batchCount++;
      }
      try {
        const methods: string[] = [];
        stdin.write(`${target}\n${sources.map((source) => source.fd).join(" ")}\n`);
        await receive(".", (line) => {
          const result = /^copy offload: .*, reflink: (.*), sparse detection: /u.exec(line);
          if (result) {
            methods.push(result[1]!);
          }
        });
        if (details) {
          for (const [index, source] of sources.entries()) {
            // Older cp has no transfer report; never label an unobserved result a clone.
            const method = methods.length === sources.length ? methods[index] : undefined;
            const kind =
              method === "yes"
                ? "cloned"
                : !method || method === "unknown"
                  ? "unreported"
                  : "copied";
            const files = `${kind}Files` as const;
            const bytes = `${kind}Bytes` as const;
            details[files] = (details[files] ?? 0) + 1;
            details[bytes] = (details[bytes] ?? 0) + source.bytes;
            if (kind === "copied") {
              details.reflinkFallbackReason ??= method;
            }
          }
        }
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
