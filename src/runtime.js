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
