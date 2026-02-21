import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type DockerStatus = {
  installed: boolean;
  running: boolean;
  version?: string;
  error?: string;
};

/**
 * Checks the current status of Docker on the system.
 */
export async function getDockerStatus(): Promise<DockerStatus> {
  try {
    const { stdout: version } = await execAsync("docker --version");
    try {
      await execAsync("docker info");
      return { installed: true, running: true, version: version.trim() };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { installed: true, running: false, version: version.trim(), error: message };
    }
  } catch {
    return { installed: false, running: false };
  }
}

/**
 * Attempts to install Docker on the current platform using native package managers.
 */
export async function installDockerNative(): Promise<{ ok: boolean; message: string }> {
  if (process.platform === "darwin") {
    try {
      await execAsync("command -v brew");
      await execAsync("brew install --cask docker");
      return { ok: true, message: "Docker Desktop installed via Homebrew." };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `Failed to install on Mac: ${message}` };
    }
  } else if (process.platform === "win32") {
    try {
      await execAsync(
        "winget install Docker.DockerDesktop --accept-package-agreements --accept-source-agreements",
      );
      return { ok: true, message: "Docker Desktop installed via winget." };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `Failed to install on Windows: ${message}` };
    }
  } else if (process.platform === "linux") {
    try {
      await execAsync("sudo apt-get update && sudo apt-get install -y docker.io");
      return { ok: true, message: "Docker installed via apt." };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `Failed to install on Linux: ${message}` };
    }
  }
  return { ok: false, message: `Unsupported platform: ${process.platform}` };
}

/**
 * Ensures the Docker daemon is running, attempting to start it if necessary.
 */
export async function ensureDockerDaemon(
  opts: {
    retries?: number;
    intervalMs?: number;
    onLog?: (msg: string) => void;
  } = {},
): Promise<boolean> {
  const { retries = 30, intervalMs = 2000, onLog = () => {} } = opts;

  let currentRetries = retries;
  let didAttemptLaunch = false;

  while (currentRetries > 0) {
    try {
      await execAsync("docker info");
      return true; // Docker is ready
    } catch (e: unknown) {
      if (!didAttemptLaunch) {
        onLog("🐳 [DOCKER] Daemon not running. Attempting to start Docker...");
        try {
          if (process.platform === "darwin") {
            await execAsync("open -a Docker");
          } else if (process.platform === "win32") {
            const winPath = "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe";
            await execAsync(`start "" "${winPath}"`);
          } else if (process.platform === "linux") {
            await execAsync("sudo systemctl start docker");
          }
          didAttemptLaunch = true;
        } catch (launchErr: unknown) {
          const message = launchErr instanceof Error ? launchErr.message : String(launchErr);
          onLog(`⚠️ [DOCKER] Startup failed: ${message}`);
        }
      }

      currentRetries--;
      if (currentRetries === 0) {
        onLog(
          `❌ [DOCKER] Daemon not reachable after ${retries * (intervalMs / 1000)}s: ${e instanceof Error ? e.message : String(e)}`,
        );
        return false;
      }
      onLog(`⏳ [DOCKER] Waiting for daemon... (${currentRetries} retries left)`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  return false;
}
