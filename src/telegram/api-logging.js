import { danger } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
const fallbackLogger = createSubsystemLogger("telegram/api");
function resolveTelegramApiLogger(runtime, logger) {
    if (logger) {
        return logger;
    }
    if (runtime?.error) {
        return runtime.error;
    }
    return (message) => fallbackLogger.error(message);
}
export async function withTelegramApiErrorLogging({ operation, fn, runtime, logger, shouldLog, }) {
    try {
        return await fn();
    }
    catch (err) {
        if (!shouldLog || shouldLog(err)) {
            const errText = formatErrorMessage(err);
            const log = resolveTelegramApiLogger(runtime, logger);
            log(danger(`telegram ${operation} failed: ${errText}`));
        }
        throw err;
    }
}
