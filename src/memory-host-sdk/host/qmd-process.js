import { spawn } from "node:child_process";
import { materializeWindowsSpawnProgram, resolveWindowsSpawnProgram, } from "../../plugin-sdk/windows-spawn.js";
export function resolveCliSpawnInvocation(params) {
    const program = resolveWindowsSpawnProgram({
        command: params.command,
        platform: process.platform,
        env: params.env,
        execPath: process.execPath,
        packageName: params.packageName,
        allowShellFallback: false,
    });
    return materializeWindowsSpawnProgram(program, params.args);
}
export async function checkQmdBinaryAvailability(params) {
    let spawnInvocation;
    try {
        spawnInvocation = resolveCliSpawnInvocation({
            command: params.command,
            args: [],
            env: params.env,
            packageName: "qmd",
        });
    }
    catch (err) {
        return { available: false, error: formatQmdAvailabilityError(err) };
    }
    return await new Promise((resolve) => {
        let settled = false;
        let didSpawn = false;
        const finish = (result) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timer) {
                clearTimeout(timer);
            }
            resolve(result);
        };
        const child = spawn(spawnInvocation.command, spawnInvocation.argv, {
            env: params.env,
            cwd: params.cwd ?? process.cwd(),
            shell: spawnInvocation.shell,
            windowsHide: spawnInvocation.windowsHide,
            stdio: "ignore",
        });
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            finish({
                available: false,
                error: `spawn ${params.command} timed out after ${params.timeoutMs ?? 2_000}ms`,
            });
        }, params.timeoutMs ?? 2_000);
        child.once("error", (err) => {
            finish({ available: false, error: formatQmdAvailabilityError(err) });
        });
        child.once("spawn", () => {
            didSpawn = true;
            child.kill();
            finish({ available: true });
        });
        child.once("close", () => {
            if (!didSpawn) {
                return;
            }
            finish({ available: true });
        });
    });
}
export async function runCliCommand(params) {
    return await new Promise((resolve, reject) => {
        const child = spawn(params.spawnInvocation.command, params.spawnInvocation.argv, {
            env: params.env,
            cwd: params.cwd,
            shell: params.spawnInvocation.shell,
            windowsHide: params.spawnInvocation.windowsHide,
        });
        let stdout = "";
        let stderr = "";
        let stdoutTruncated = false;
        let stderrTruncated = false;
        const discardStdout = params.discardStdout === true;
        const timer = params.timeoutMs
            ? setTimeout(() => {
                child.kill("SIGKILL");
                reject(new Error(`${params.commandSummary} timed out after ${params.timeoutMs}ms`));
            }, params.timeoutMs)
            : null;
        child.stdout.on("data", (data) => {
            if (discardStdout) {
                return;
            }
            const next = appendOutputWithCap(stdout, data.toString("utf8"), params.maxOutputChars);
            stdout = next.text;
            stdoutTruncated = stdoutTruncated || next.truncated;
        });
        child.stderr.on("data", (data) => {
            const next = appendOutputWithCap(stderr, data.toString("utf8"), params.maxOutputChars);
            stderr = next.text;
            stderrTruncated = stderrTruncated || next.truncated;
        });
        child.on("error", (err) => {
            if (timer) {
                clearTimeout(timer);
            }
            reject(err);
        });
        child.on("close", (code) => {
            if (timer) {
                clearTimeout(timer);
            }
            if (!discardStdout && (stdoutTruncated || stderrTruncated)) {
                reject(new Error(`${params.commandSummary} produced too much output (limit ${params.maxOutputChars} chars)`));
                return;
            }
            if (code === 0) {
                resolve({ stdout, stderr });
            }
            else {
                reject(new Error(`${params.commandSummary} failed (code ${code}): ${stderr || stdout}`));
            }
        });
    });
}
function appendOutputWithCap(current, chunk, maxChars) {
    const appended = current + chunk;
    if (appended.length <= maxChars) {
        return { text: appended, truncated: false };
    }
    return { text: appended.slice(-maxChars), truncated: true };
}
function formatQmdAvailabilityError(err) {
    if (err instanceof Error && err.message) {
        return err.message;
    }
    return String(err);
}
