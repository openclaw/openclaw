import { clearActiveProgressLine } from "./terminal/progress-line.js";
import { restoreTerminalState } from "./terminal/restore.js";
function shouldEmitRuntimeLog(env = process.env) {
    if (env.VITEST !== "true") {
        return true;
    }
    if (env.OPENCLAW_TEST_RUNTIME_LOG === "1") {
        return true;
    }
    const maybeMockedLog = console.log;
    return typeof maybeMockedLog.mock === "object";
}
function shouldEmitRuntimeStdout(env = process.env) {
    if (env.VITEST !== "true") {
        return true;
    }
    if (env.OPENCLAW_TEST_RUNTIME_LOG === "1") {
        return true;
    }
    const stdout = process.stdout;
    return typeof stdout.write.mock === "object";
}
function isPipeClosedError(err) {
    const code = err?.code;
    return code === "EPIPE" || code === "EIO";
}
function hasRuntimeOutputWriter(runtime) {
    return typeof runtime.writeStdout === "function";
}
function writeStdout(value) {
    if (!shouldEmitRuntimeStdout()) {
        return;
    }
    clearActiveProgressLine();
    const line = value.endsWith("\n") ? value : `${value}\n`;
    try {
        process.stdout.write(line);
    }
    catch (err) {
        if (isPipeClosedError(err)) {
            return;
        }
        throw err;
    }
}
function createRuntimeIo() {
    return {
        log: (...args) => {
            if (!shouldEmitRuntimeLog()) {
                return;
            }
            clearActiveProgressLine();
            console.log(...args);
        },
        error: (...args) => {
            clearActiveProgressLine();
            console.error(...args);
        },
        writeStdout,
        writeJson: (value, space = 2) => {
            writeStdout(JSON.stringify(value, null, space > 0 ? space : undefined));
        },
    };
}
export const defaultRuntime = {
    ...createRuntimeIo(),
    exit: (code) => {
        restoreTerminalState("runtime exit", { resumeStdinIfPaused: false });
        process.exit(code);
        throw new Error("unreachable"); // satisfies tests when mocked
    },
};
export function createNonExitingRuntime() {
    return {
        ...createRuntimeIo(),
        exit: (code) => {
            throw new Error(`exit ${code}`);
        },
    };
}
export function writeRuntimeJson(runtime, value, space = 2) {
    if (hasRuntimeOutputWriter(runtime)) {
        runtime.writeJson(value, space);
        return;
    }
    runtime.log(JSON.stringify(value, null, space > 0 ? space : undefined));
}
