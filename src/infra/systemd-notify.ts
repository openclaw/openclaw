import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SystemdNotifier = {
  ready: () => void | Promise<void>;
  watchdog: () => void | Promise<void>;
};

type SystemdNotifierLog = {
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type SystemdNotifierOptions = {
  env?: NodeJS.ProcessEnv;
  command?: string;
  log?: SystemdNotifierLog;
};

function hasNotifySocket(env: NodeJS.ProcessEnv): boolean {
  return typeof env.NOTIFY_SOCKET === "string" && env.NOTIFY_SOCKET.trim().length > 0;
}

function formatSystemdNotifyError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return String(error);
}

function logSystemdNotifyUnavailable(log: SystemdNotifierLog | undefined, error: unknown): void {
  const message = `systemd-notify unavailable; watchdog updates disabled: ${formatSystemdNotifyError(error)}`;
  if (log?.warn) {
    log.warn(message);
    return;
  }
  log?.error?.(message);
}

function fireAndForgetNotify(action: () => void | Promise<void>, log?: SystemdNotifierLog): void {
  void Promise.resolve()
    .then(action)
    .catch((error) => {
      log?.error?.(`systemd notify failed: ${formatSystemdNotifyError(error)}`);
    });
}

export function runSystemdNotifier(action: () => void | Promise<void>, log?: SystemdNotifierLog) {
  fireAndForgetNotify(action, log);
}

export function createSystemdNotifier({
  env = process.env,
  command = "systemd-notify",
  log,
}: SystemdNotifierOptions = {}): SystemdNotifier {
  let disabled = false;
  let warned = false;

  const notify = async (args: string[]) => {
    if (disabled || !hasNotifySocket(env)) {
      return;
    }
    try {
      await execFileAsync(command, args, { env });
    } catch (error) {
      disabled = true;
      if (!warned) {
        warned = true;
        logSystemdNotifyUnavailable(log, error);
      }
    }
  };

  return {
    ready: () => notify(["--ready", "--status=OpenClaw gateway ready"]),
    watchdog: () => notify(["--watchdog", "--status=OpenClaw gateway alive"]),
  };
}
