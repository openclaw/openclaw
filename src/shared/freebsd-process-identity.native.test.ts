import { execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readFreeBsdProcessStartTime } from "./freebsd-process-identity.js";
import { getFileLockProcessStartTime } from "./pid-alive.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(process.platform !== "freebsd")(
  "preserves the released FreeBSD lease bytes on the main thread and a real Worker",
  async () => {
    const root = tempDirs.make("freebsd-identity-proof-");
    const source = path.join(root, "identity.c");
    const executable = path.join(root, "identity");
    // Independent kernel observation of the released ki_start - kern.boottime format.
    fs.writeFileSync(
      source,
      `
#include <sys/types.h>
#include <sys/sysctl.h>
#include <sys/user.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  if (argc != 2) return 1;
  int pid = atoi(argv[1]);
  int boot_mib[] = { CTL_KERN, KERN_BOOTTIME };
  int proc_mib[] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, pid };
  struct timeval before, after;
  struct kinfo_proc info;
  size_t length = sizeof(before);
  if (sysctl(boot_mib, 2, &before, &length, NULL, 0) || length != sizeof(before)) return 2;
  length = sizeof(info);
  if (sysctl(proc_mib, 4, &info, &length, NULL, 0) || length != sizeof(info)) return 3;
  length = sizeof(after);
  if (sysctl(boot_mib, 2, &after, &length, NULL, 0) || length != sizeof(after)) return 4;
  if (before.tv_sec != after.tv_sec || before.tv_usec != after.tv_usec) return 5;
  if (sizeof(info) != 1088 || info.ki_structsize != 1088 || info.ki_layout != 0 || info.ki_pid != pid) return 6;
  int64_t value = (int64_t)(info.ki_start.tv_sec - before.tv_sec) * 1000000 + info.ki_start.tv_usec - before.tv_usec;
  if (value < 0) return 7;
  printf("%lld", (long long)value);
  return 0;
}
`,
    );
    execFileSync("cc", ["-o", executable, source]);
    const expected = execFileSync(executable, [String(process.pid)], { encoding: "utf8" });
    expect(String(readFreeBsdProcessStartTime(process.pid))).toBe(expected);
    expect(String(getFileLockProcessStartTime(process.pid))).toBe(expected);
    const worker = new Worker(
      new URL(
        `data:text/javascript,${encodeURIComponent(`
      import { parentPort } from "node:worker_threads";
      import { readFreeBsdProcessStartTime } from ${JSON.stringify(new URL("./freebsd-process-identity.ts", import.meta.url).href)};
      parentPort.postMessage(String(readFreeBsdProcessStartTime(process.pid)));
    `)}`,
      ),
    );
    try {
      const [observed] = await once(worker, "message");
      expect(observed).toBe(expected);
    } finally {
      await worker.terminate();
    }
  },
);
