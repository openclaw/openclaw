import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";

export type ExecResult = { stdout: string; stderr: string; code: number };

export async function execFileUtf8(
  command: string,
  args: string[],
  options: Omit<ExecFileOptionsWithStringEncoding, "encoding"> = {},
): Promise<ExecResult> {
  return await new Promise<ExecResult>((resolve) => {
    execFile(command, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      if (!error) {
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          code: 0,
        });
        return;
      }

      const e = error as { code?: unknown; message?: unknown };
      const stderrText = String(stderr ?? "");
      const isSpawnFailure = typeof e.code !== "number";
      resolve({
        stdout: String(stdout ?? ""),
        // Only fall back to e.message for spawn failures (ENOENT/EACCES) where
        // there is no real process output.  When the process ran but exited
        // non-zero, preserve the actual (possibly empty) stderr so that
        // downstream callers can inspect stdout without it being shadowed.
        stderr: isSpawnFailure
          ? stderrText ||
            (typeof e.message === "string" ? e.message : typeof error === "string" ? error : "")
          : stderrText,
        code: isSpawnFailure ? 1 : (e.code as number),
      });
    });
  });
}
