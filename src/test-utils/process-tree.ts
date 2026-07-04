import fs from "node:fs/promises";
import path from "node:path";

export async function writeForkingNoOutputScript(dir: string): Promise<string> {
  const scriptPath = path.join(dir, "fork-no-output.sh");
  await fs.writeFile(
    scriptPath,
    [
      "#!/bin/sh",
      '"$NODE_BINARY" -e "setInterval(() => {}, 1000)" &',
      'printf "%s" "$!" > "$PID_FILE"',
      "sleep 30",
    ].join("\n"),
    "utf8",
  );
  await fs.chmod(scriptPath, 0o700);
  return scriptPath;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForPidToExit(pid: number, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return !isPidAlive(pid);
}

export async function readPidFile(pidPath: string, timeoutMs = 5000): Promise<number> {
  // Forked helpers write their pid file at startup; under load the parent's
  // assertions can run first, so poll instead of racing a single read.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const pid = Number((await fs.readFile(pidPath, "utf8")).trim());
      if (Number.isFinite(pid) && pid > 0) {
        return pid;
      }
    } catch {
      // Keep polling until the child has written the file.
    }
    if (Date.now() >= deadline) {
      throw new Error(`pid file not written in time: ${pidPath}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

export function killPidIfAlive(pid: number | undefined): void {
  if (pid === undefined || !isPidAlive(pid)) {
    return;
  }
  process.kill(pid, "SIGKILL");
}
