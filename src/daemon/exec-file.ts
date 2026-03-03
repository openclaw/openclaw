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
      resolve({
        stdout: String(stdout ?? ""),
        // Keep real stderr only; never fall back to e.message which is a
        // Node.js synthetic string ("Command failed: ...") and pollutes
        // downstream code that inspects stderr for command-specific output.
        stderr: String(stderr ?? ""),
        code: typeof e.code === "number" ? e.code : 1,
      });
    });
  });
}
