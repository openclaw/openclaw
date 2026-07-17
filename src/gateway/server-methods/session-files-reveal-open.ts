import { runExec, spawnCommand } from "../../process/exec.js";

const SESSION_WORKSPACE_OPEN_TIMEOUT_MS = 5_000;
const XDG_OPEN_STARTUP_OBSERVATION_MS = 5_000;
const XDG_OPEN_STDERR_MAX_CHARS = 4_096;

type SessionWorkspaceOpenCommand = {
  command: string;
  args: string[];
};

async function observeXdgOpenStartup(command: SessionWorkspaceOpenCommand): Promise<void> {
  // xdg-open can synchronously own a foreground editor. Observe only startup
  // failures so the Gateway never owns the launched application's lifetime.
  const child = spawnCommand([command.command, ...command.args], {
    buffer: false,
    cleanup: false,
    detached: true,
    reject: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.unref();
  let stderrText = "";
  const stderr = child.stderr;
  stderr?.setEncoding("utf8");
  const onStderr = (chunk: string | Buffer) => {
    if (stderrText.length >= XDG_OPEN_STDERR_MAX_CHARS) {
      return;
    }
    stderrText += String(chunk).slice(0, XDG_OPEN_STDERR_MAX_CHARS - stderrText.length);
  };
  stderr?.on("data", onStderr);

  await new Promise<void>((resolve, reject) => {
    let observationComplete = false;
    const releaseStderr = (childSettled: boolean) => {
      stderr?.off("data", onStderr);
      if (childSettled) {
        stderr?.destroy();
        return;
      }
      // Keep draining the pipe after the observation window. Closing it while
      // xdg-open owns a foreground handler can make a later stderr write fail
      // with SIGPIPE and terminate the application we intentionally detached.
      stderr?.resume();
      (stderr as (typeof stderr & { unref?: () => void }) | null)?.unref?.();
    };
    const timer = setTimeout(() => {
      observationComplete = true;
      releaseStderr(false);
      resolve();
    }, XDG_OPEN_STARTUP_OBSERVATION_MS);
    void child.then(
      () => {
        clearTimeout(timer);
        releaseStderr(true);
        if (observationComplete) {
          return;
        }
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        releaseStderr(true);
        if (observationComplete) {
          return;
        }
        const commandError = error instanceof Error ? error : new Error(String(error));
        const diagnostic = stderrText.trim();
        reject(
          diagnostic
            ? new Error(`${commandError.message}: ${diagnostic}`, { cause: commandError })
            : commandError,
        );
      },
    );
  });
}

export async function execSessionWorkspaceOpen(
  command: SessionWorkspaceOpenCommand,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === "linux") {
    await observeXdgOpenStartup(command);
    return;
  }
  await runExec(command.command, command.args, {
    logOutput: false,
    timeoutMs: SESSION_WORKSPACE_OPEN_TIMEOUT_MS,
  });
}
