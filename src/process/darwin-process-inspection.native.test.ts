import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readDarwinProcessCensus, readDarwinProcessTree } from "./darwin-process-inspection.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.runIf(process.platform === "darwin").each([false, true])(
  "inspects real process topology, identities, and arguments on main and Worker (Seatbelt=%s)",
  async (seatbelt) => {
    const fixture = fileURLToPath(
      import.meta.resolve("./darwin-process-inspection.test-support.mjs"),
    );
    const command = seatbelt ? "/usr/bin/sandbox-exec" : process.execPath;
    // Seatbelt refuses Apple's setuid ps even with default access allowed.
    const args = seatbelt
      ? ["-p", "(version 1)(allow default)", process.execPath, fixture, "--seatbelt"]
      : [fixture];
    const { stdout } = await promisify(execFile)(command, args);
    expect(JSON.parse(stdout)).toEqual({
      threads: 2,
      child: "observed",
      startedAtCompatible: true,
      psBlocked: seatbelt,
    });
  },
);

// The setsid child's last pty close must drain output nobody reads, which holds
// it where libproc reports ESRCH while kern.proc.pid still shows P_WEXIT. Each
// "exiting" line re-verifies that kernel window, so a late census cannot pass.
const EXITING_CHILD_FIXTURE = String.raw`
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static pid_t child;

static int exiting(void) {
  struct proc_bsdshortinfo info;
  errno = 0;
  int result = proc_pidinfo(child, PROC_PIDT_SHORTBSDINFO, 0, &info, sizeof(info));
  int error = errno;
  int mib[] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, child };
  struct kinfo_proc kernel = {0};
  size_t length = sizeof(kernel);
  if (sysctl(mib, 4, &kernel, &length, NULL, 0) != 0 || length != sizeof(kernel)) return -1;
  int window = result <= 0 && error == ESRCH && (kernel.kp_proc.p_flag & P_WEXIT) != 0;
  if (kernel.kp_proc.p_stat == SZOMB || (!window && result <= 0)) {
    fprintf(stderr, "outside exit window\n");
    return -1;
  }
  return window;
}

static double now_ms(void) {
  struct timespec time;
  if (clock_gettime(CLOCK_MONOTONIC, &time) != 0) abort();
  return time.tv_sec * 1000.0 + time.tv_nsec / 1000000.0;
}

int main(void) {
  int master = posix_openpt(O_RDWR | O_NOCTTY);
  if (master < 0 || grantpt(master) != 0 || unlockpt(master) != 0) return 1;
  char *slave_path = ptsname(master);
  int gate[2], ready[2];
  if (slave_path == NULL || pipe(gate) != 0 || pipe(ready) != 0) return 1;
  child = fork();
  if (child < 0) return 1;
  if (child == 0) {
    close(master); close(gate[1]); close(ready[0]);
    int slave = setsid() == getpid() ? open(slave_path, O_RDWR | O_NOCTTY | O_NONBLOCK) : -1;
    if (slave < 0) _exit(1);
    char buffer[1024] = {0};
    while (write(slave, buffer, sizeof(buffer)) > 0) {}
    if (errno != EAGAIN || fcntl(slave, F_SETFL, 0) != 0) _exit(1);
    char released;
    if (write(ready[1], "r", 1) != 1 || read(gate[0], &released, 1) != 1) _exit(1);
    _exit(0);
  }
  close(gate[0]); close(ready[1]);
  char started;
  if (read(ready[0], &started, 1) != 1) return 1;
  printf("%d\n", child); fflush(stdout);
  int command;
  while ((command = getchar()) != EOF) {
    int state = 0;
    if (command == 'e') {
      double released = now_ms();
      if (write(gate[1], "e", 1) != 1) return 1;
      while ((state = exiting()) == 0 && now_ms() - released < 5000) {}
    } else if (command == 'w') {
      state = exiting();
    }
    if (state != 1) {
      fprintf(stderr, "exit window missed after command %c\n", command);
      return 1;
    }
    puts("exiting"); fflush(stdout);
  }
  // Closing the gate also releases a child that was never told to exit.
  close(gate[1]); close(master);
  return waitpid(child, NULL, 0) == child ? 0 : 1;
}
`;

it.runIf(process.platform === "darwin")(
  "keeps an exiting descendant in tree and full census observations",
  async () => {
    const root = tempDirs.make("darwin-exiting-child-");
    const source = path.join(root, "exiting-child.c");
    const executable = path.join(root, "exiting-child");
    fs.writeFileSync(source, EXITING_CHILD_FIXTURE);
    execFileSync("cc", ["-o", executable, source]);
    const fixture = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
    const closed = once(fixture, "close");
    let stderr = "";
    fixture.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const lines = createInterface({ input: fixture.stdout })[Symbol.asyncIterator]();
    const next = async () => (await lines.next()).value ?? `fixture closed: ${stderr}`;
    try {
      const pid = Number(await next());
      fixture.stdin.write("e");
      expect(await next()).toBe("exiting");
      const tree = await readDarwinProcessTree(performance.now() + 2000, [fixture.pid!]);
      const census = [...readDarwinProcessCensus(2000)];
      fixture.stdin.write("w");
      expect(await next()).toBe("exiting");
      const exiting = { pid, ppid: fixture.pid, pgid: pid, state: "R", owner: "same" };
      expect(tree).toContainEqual({ ...exiting, startedAt: expect.any(String) });
      expect(census).toContainEqual(exiting);
    } finally {
      fixture.stdin.end();
      await closed;
    }
    expect(fixture.exitCode).toBe(0);
  },
);
