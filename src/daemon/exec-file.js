import { execFile } from "node:child_process";
export async function execFileUtf8(command, args, options = {}) {
    return await new Promise((resolve) => {
        execFile(command, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
            if (!error) {
                resolve({
                    stdout: stdout ?? "",
                    stderr: stderr ?? "",
                    code: 0,
                });
                return;
            }
            const e = error;
            const stderrText = stderr ?? "";
            resolve({
                stdout: stdout ?? "",
                stderr: stderrText ||
                    (typeof e.message === "string" ? e.message : typeof error === "string" ? error : ""),
                code: typeof e.code === "number" ? e.code : 1,
            });
        });
    });
}
