import type { ExecFileOptionsWithStringEncoding } from "node:child_process";
import type { ExecResult } from "./exec-file.js";

export type ExecFileError = Error & {
  stderr?: string;
  code?: string | number;
  termination?: ExecResult["termination"];
};
type ExecFileCallback = (error: ExecFileError | null, stdout: string, stderr: string) => void;
export type ExecFileMock = (
  command: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: ExecFileCallback,
) => unknown;

export const createExecFileError = (
  message: string,
  options: Pick<ExecFileError, "stderr" | "code" | "termination"> = {},
): ExecFileError => {
  const err = new Error(message) as ExecFileError;
  err.code = options.code ?? 1;
  err.termination = options.termination;
  if (options.stderr) {
    err.stderr = options.stderr;
  }
  return err;
};
