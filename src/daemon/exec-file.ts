import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";

export type ExecResult = {
  stdout: string;
  stderr: string;
  code: number;
  timedOut?: boolean;
};

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

      const e = error as {
        code?: unknown;
        message?: unknown;
        killed?: unknown;
        signal?: unknown;
      };
      const stderrText = String(stderr ?? "");
      const timedOut =
        typeof options.timeout === "number" &&
        options.timeout > 0 &&
        e.killed === true &&
        (typeof e.code !== "number" || typeof e.signal === "string");
      resolve({
        stdout: String(stdout ?? ""),
        stderr:
          stderrText ||
          (typeof e.message === "string" ? e.message : typeof error === "string" ? error : ""),
        code: typeof e.code === "number" ? e.code : 1,
        ...(timedOut ? { timedOut: true } : {}),
      });
    });
  });
}
