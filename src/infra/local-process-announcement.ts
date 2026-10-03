import { spawn, type ChildProcess } from "node:child_process";
import { formatOpenClawProcessTitleForRoots } from "./openclaw-installation-id.js";

export const LOCAL_PROCESS_ANNOUNCEMENT_MARKER = "openclaw-process-announcement";
const ANNOUNCEMENT_TIMEOUT_MS = 5_000;
const ANNOUNCEMENT_SCRIPT =
  "const parent=Number(process.argv[2]);if(process.platform==='win32')process.title=process.argv[3];process.stdout.write('ready\\n');setInterval(()=>{try{process.kill(parent,0)}catch{process.exit(0)}},250)";

export type LocalTuiUpdateAnnouncement = {
  pid: number;
  release: () => Promise<void>;
};

async function stopAnnouncement(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  if (!child.kill()) {
    throw new Error(`Could not stop local TUI update announcement ${child.pid ?? "unknown"}.`);
  }
  await exited;
}

async function announceLocalOpenClawProcess(
  name: "openclaw-tui" | "openclaw-update",
  roots: readonly string[],
): Promise<LocalTuiUpdateAnnouncement> {
  const title = formatOpenClawProcessTitleForRoots(name, roots);
  const child = spawn(
    process.execPath,
    ["-e", ANNOUNCEMENT_SCRIPT, LOCAL_PROCESS_ANNOUNCEMENT_MARKER, String(process.pid), title],
    {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      ...(process.platform === "win32" ? {} : { argv0: `${title}#${process.pid}` }),
    },
  );
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out publishing the local TUI update announcement."));
    }, ANNOUNCEMENT_TIMEOUT_MS);
    const settle = (operation: () => void) => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
      operation();
    };
    const onError = (error: Error) => settle(() => reject(error));
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      settle(() =>
        reject(
          new Error(
            `Local TUI update announcement exited before readiness (${signal ?? code ?? "unknown"}).`,
          ),
        ),
      );
    child.once("error", onError);
    child.once("exit", onExit);
    child.stdout?.once("data", () => settle(resolve));
  }).catch((error: unknown) => {
    child.kill();
    throw error;
  });
  const pid = child.pid;
  if (!pid) {
    child.kill();
    throw new Error("Local TUI update announcement is missing its process id.");
  }
  return { pid, release: async () => await stopAnnouncement(child) };
}

/** Publishes activation through a small runtime-independent child process. */
export async function announceLocalTuiUpdate(
  roots: readonly string[],
): Promise<LocalTuiUpdateAnnouncement> {
  return await announceLocalOpenClawProcess("openclaw-update", roots);
}

/** Makes an internal TUI visible independently of its launch command or title capacity. */
export async function announceLocalTuiClient(root: string): Promise<LocalTuiUpdateAnnouncement> {
  return await announceLocalOpenClawProcess("openclaw-tui", [root]);
}
