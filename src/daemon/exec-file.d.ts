import { type ExecFileOptionsWithStringEncoding } from "node:child_process";
export type ExecResult = {
    stdout: string;
    stderr: string;
    code: number;
};
export declare function execFileUtf8(command: string, args: string[], options?: Omit<ExecFileOptionsWithStringEncoding, "encoding">): Promise<ExecResult>;
