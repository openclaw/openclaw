import { isTruthyEnvValue } from "../infra/env.js";
export function resolveDoctorRepairMode(options) {
    const yes = options.yes === true;
    const requestedNonInteractive = options.nonInteractive === true;
    const shouldRepair = options.repair === true || yes;
    const shouldForce = options.force === true;
    const isTty = process.stdin.isTTY;
    const nonInteractive = requestedNonInteractive || (!isTty && !yes);
    const updateInProgress = isTruthyEnvValue(process.env.OPENCLAW_UPDATE_IN_PROGRESS);
    const canPrompt = isTty && !yes && !nonInteractive;
    return {
        shouldRepair,
        shouldForce,
        nonInteractive,
        canPrompt,
        updateInProgress,
    };
}
export function isDoctorUpdateRepairMode(mode) {
    return mode.updateInProgress && mode.nonInteractive;
}
export function shouldAutoApproveDoctorFix(mode, params = {}) {
    if (!mode.shouldRepair) {
        return false;
    }
    if (params.requiresForce && !mode.shouldForce) {
        return false;
    }
    if (params.blockDuringUpdate && isDoctorUpdateRepairMode(mode)) {
        return false;
    }
    return true;
}
