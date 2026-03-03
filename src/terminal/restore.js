import { clearActiveProgressLine } from "./progress-line.js";
const RESET_SEQUENCE = "\x1b[0m\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l";
function reportRestoreFailure(scope, err, reason) {
    const suffix = reason ? ` (${reason})` : "";
    const message = `[terminal] restore ${scope} failed${suffix}: ${String(err)}`;
    try {
        process.stderr.write(`${message}\n`);
    }
    catch (writeErr) {
        console.error(`[terminal] restore reporting failed${suffix}: ${String(writeErr)}`);
    }
}
export function restoreTerminalState(reason, options = {}) {
    // Docker TTY note: resuming stdin can keep a container process alive even
    // after the wizard is "done" (stdin_open: true), making installers appear hung.
    const resumeStdin = options.resumeStdinIfPaused ?? options.resumeStdin ?? false;
    try {
        clearActiveProgressLine();
    }
    catch (err) {
        reportRestoreFailure("progress line", err, reason);
    }
    const stdin = process.stdin;
    if (stdin.isTTY && typeof stdin.setRawMode === "function") {
        try {
            stdin.setRawMode(false);
        }
        catch (err) {
            reportRestoreFailure("raw mode", err, reason);
        }
        if (resumeStdin && typeof stdin.isPaused === "function" && stdin.isPaused()) {
            try {
                stdin.resume();
            }
            catch (err) {
                reportRestoreFailure("stdin resume", err, reason);
            }
        }
    }
    if (process.stdout.isTTY) {
        try {
            process.stdout.write(RESET_SEQUENCE);
        }
        catch (err) {
            reportRestoreFailure("stdout reset", err, reason);
        }
    }
}
