import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const observer = fileURLToPath(new URL("./cli-process-tree.test-support.cjs", import.meta.url));

/** Capture outside the child, before signaling can change the blocked state. */
export function captureCliProcessTree(pid: number | undefined): Promise<string> {
  if (pid === undefined || process.platform === "win32") {
    return Promise.resolve("Process tree unavailable: no PID or unsupported platform.");
  }
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [observer, String(pid)],
      {
        timeout: 1_000,
        killSignal: "SIGKILL",
        maxBuffer: 256 * 1024,
        env: { PATH: process.env.PATH },
      },
      (error, stdout) =>
        resolve(
          [
            stdout.trim(),
            ...(error
              ? [`Process tree incomplete: ${error.code ?? error.signal ?? "capture failed"}`]
              : []),
          ]
            .filter(Boolean)
            .join("\n"),
        ),
    );
  });
}
