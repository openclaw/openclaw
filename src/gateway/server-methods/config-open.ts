import { runExec, spawnCommand } from "../../process/exec.js";

const CONFIG_OPEN_COMMAND_TIMEOUT_MS = 5_000;
const XDG_OPEN_STARTUP_OBSERVATION_MS = 5_000;

type ConfigOpenCommand = {
  command: string;
  args: string[];
  completion: "exit" | "startup";
};

class ConfigOpenCommandError extends Error {
  readonly handlerUnavailable: boolean;

  constructor(message: string, handlerUnavailable: boolean) {
    super(message);
    this.name = "ConfigOpenCommandError";
    this.handlerUnavailable = handlerUnavailable;
  }
}

function escapePowerShellSingleQuotedString(value: string): string {
  return value.replaceAll("'", "''");
}

export function resolveConfigOpenCommand(
  configPath: string,
  platform: NodeJS.Platform = process.platform,
): ConfigOpenCommand {
  if (platform === "win32") {
    // Use a PowerShell string literal so the path stays data, not code.
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Start-Process -FilePath '${escapePowerShellSingleQuotedString(configPath)}'`,
      ],
      completion: "exit",
    };
  }
  if (platform === "darwin") {
    return {
      command: "open",
      args: [configPath],
      completion: "exit",
    };
  }
  return {
    command: "xdg-open",
    args: [configPath],
    completion: "startup",
  };
}

export function formatConfigOpenError(error: unknown): string {
  if (
    typeof error === "object" &&
    error &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

export function isConfigOpenHandlerUnavailable(error: unknown): boolean {
  if (error instanceof ConfigOpenCommandError && error.handlerUnavailable) {
    return true;
  }
  const message = formatConfigOpenError(error);
  return message.includes("xdg-open") && message.includes("no method available");
}

async function observeXdgOpenStartup(command: ConfigOpenCommand): Promise<void> {
  // xdg-open may synchronously own the selected foreground application. Run it
  // detached while observing early failures so Gateway never owns app lifetime.
  const child = spawnCommand([command.command, ...command.args], {
    cleanup: false,
    detached: true,
    reject: false,
    stdio: "ignore",
  });
  child.unref();

  await new Promise<void>((resolve, reject) => {
    const startupTimer = setTimeout(resolve, XDG_OPEN_STARTUP_OBSERVATION_MS);
    void child.then(
      (result) => {
        clearTimeout(startupTimer);
        if (result.failed) {
          reject(new ConfigOpenCommandError(formatConfigOpenError(result), result.exitCode === 3));
          return;
        }
        resolve();
      },
      (error: unknown) => {
        clearTimeout(startupTimer);
        reject(error);
      },
    );
  });
}

export async function execConfigOpenCommand(command: ConfigOpenCommand): Promise<void> {
  if (command.completion === "startup") {
    await observeXdgOpenStartup(command);
    return;
  }
  await runExec(command.command, command.args, {
    logOutput: false,
    timeoutMs: CONFIG_OPEN_COMMAND_TIMEOUT_MS,
  });
}
