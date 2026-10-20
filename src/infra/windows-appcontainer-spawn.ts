import type { StdioOptions } from "node:child_process";
import { createRequire } from "node:module";

export class AppContainerSpawnUnsupportedError extends Error {
  readonly code = "APPCONTAINER_SPAWN_UNSUPPORTED";

  constructor(uvVersion: string) {
    super(
      `AppContainer: libuv ${uvVersion} cannot create child pipes; 1.53.0+ required. ` +
        "Run OpenClaw outside the AppContainer or use a Node build with libuv >= 1.53.0.",
    );
    this.name = "AppContainerSpawnUnsupportedError";
  }
}

let checked = false;
let unsupported: AppContainerSpawnUnsupportedError | undefined;

/** libuv before 1.53 loops forever creating child pipes in an AppContainer. */
export function assertAppContainerSpawnSupported(stdio?: StdioOptions): void {
  if (process.platform !== "win32") {
    return;
  }
  if (
    stdio === "ignore" ||
    stdio === "inherit" ||
    (Array.isArray(stdio) &&
      stdio.length >= 3 &&
      stdio.every(
        (entry) =>
          entry !== undefined &&
          entry !== null &&
          entry !== "pipe" &&
          entry !== "overlapped" &&
          entry !== "ipc" &&
          !(typeof entry === "number" && entry < 0),
      ))
  ) {
    return;
  }
  if (!checked) {
    checked = true;
    try {
      // Keep the token reader and its native loader off non-Windows import paths.
      const tokenModule = createRequire(import.meta.url)("@openclaw/proc-safe/windows-token");
      const { readCurrentAppContainerSid } =
        // SAFETY: this exact pinned CommonJS subpath implements the imported declaration.
        tokenModule as typeof import("@openclaw/proc-safe/windows-token");
      const sid = readCurrentAppContainerSid();
      const uv = process.versions.uv;
      const major = Number(uv.split(".")[0]);
      const minor = Number(uv.split(".")[1]);
      if (sid !== null && (major < 1 || (major === 1 && minor < 53))) {
        unsupported = new AppContainerSpawnUnsupportedError(uv);
      }
    } catch (error) {
      void import("../logging/subsystem.js")
        .then(({ createSubsystemLogger }) => {
          createSubsystemLogger("process").debug(
            "AppContainer token probe failed; allowing spawn",
            {
              error: String(error),
            },
          );
        })
        .catch(() => {});
    }
  }
  if (unsupported) {
    throw unsupported;
  }
}
