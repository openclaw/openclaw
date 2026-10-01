import childProcess, { type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { vi } from "vitest";

/** Own only synthetic native children; never kill by a global name or PID lookup. */
export async function createParityAppFixture(workspace: string, installedApp: boolean) {
  const appChildren: ChildProcess[] = [];
  const appExecutable = path.join(workspace, "parity-native-app");
  const appData = path.join(workspace, "parity-app-data");
  const cleanupAppChildren = async () => {
    for (const child of appChildren) {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit");
        child.kill("SIGKILL");
        await exit;
      }
    }
  };
  const originalSpawn = childProcess.spawn;
  const observeApp = installedApp
    ? vi
        .spyOn(childProcess, "spawn")
        .mockImplementation((...args: Parameters<typeof originalSpawn>) => {
          const child = originalSpawn(...args);
          if (args[0] === appExecutable) {
            appChildren.push(child);
          }
          return child;
        })
    : undefined;
  if (installedApp) {
    await fs.mkdir(path.join(appData, "applications"), { recursive: true });
    await fs.copyFile("/usr/bin/yes", appExecutable);
    await fs.chmod(appExecutable, 0o755);
    await fs.writeFile(
      path.join(appData, "applications", "parity.desktop"),
      "[Desktop Entry]\nType=Application\nName=Parity app\nExec=" + appExecutable + "\n",
    );
    vi.stubEnv("XDG_DATA_HOME", appData);
    vi.stubEnv("XDG_DATA_DIRS", appData);
    syncBuiltinESMExports();
  }
  return {
    children: appChildren,
    cleanup: cleanupAppChildren,
    restore: () => {
      observeApp?.mockRestore();
      if (installedApp) {
        vi.unstubAllEnvs();
        syncBuiltinESMExports();
      }
    },
  };
}
