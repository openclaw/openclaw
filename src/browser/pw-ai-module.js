import { extractErrorCode, formatErrorMessage } from "../infra/errors.js";
let pwAiModuleSoft = null;
let pwAiModuleStrict = null;
function isModuleNotFoundError(err) {
    const code = extractErrorCode(err);
    if (code === "ERR_MODULE_NOT_FOUND") {
        return true;
    }
    const msg = formatErrorMessage(err);
    return (msg.includes("Cannot find module") ||
        msg.includes("Cannot find package") ||
        msg.includes("Failed to resolve import") ||
        msg.includes("Failed to resolve entry for package") ||
        msg.includes("Failed to load url"));
}
async function loadPwAiModule(mode) {
    try {
        return await import("./pw-ai.js");
    }
    catch (err) {
        if (mode === "soft") {
            return null;
        }
        if (isModuleNotFoundError(err)) {
            return null;
        }
        throw err;
    }
}
export async function getPwAiModule(opts) {
    const mode = opts?.mode ?? "soft";
    if (mode === "soft") {
        if (!pwAiModuleSoft) {
            pwAiModuleSoft = loadPwAiModule("soft");
        }
        return await pwAiModuleSoft;
    }
    if (!pwAiModuleStrict) {
        pwAiModuleStrict = loadPwAiModule("strict");
    }
    return await pwAiModuleStrict;
}
