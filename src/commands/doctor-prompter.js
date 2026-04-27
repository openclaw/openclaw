import { confirm, select } from "@clack/prompts";
import { stylePromptHint, stylePromptMessage } from "../terminal/prompt-style.js";
import { resolveDoctorRepairMode, shouldAutoApproveDoctorFix, } from "./doctor-repair-mode.js";
import { guardCancel } from "./onboard-helpers.js";
export function createDoctorPrompter(params) {
    const repairMode = resolveDoctorRepairMode(params.options);
    const confirmDefault = async (p) => {
        if (shouldAutoApproveDoctorFix(repairMode)) {
            return true;
        }
        if (repairMode.nonInteractive) {
            return false;
        }
        if (!repairMode.canPrompt) {
            return p.initialValue ?? false;
        }
        return guardCancel(await confirm({
            ...p,
            message: stylePromptMessage(p.message),
        }), params.runtime);
    };
    return {
        confirm: confirmDefault,
        confirmAutoFix: confirmDefault,
        confirmAggressiveAutoFix: async (p) => {
            if (shouldAutoApproveDoctorFix(repairMode, { requiresForce: true })) {
                return true;
            }
            if (repairMode.nonInteractive) {
                return false;
            }
            if (repairMode.shouldRepair && !repairMode.shouldForce) {
                return false;
            }
            if (!repairMode.canPrompt) {
                return p.initialValue ?? false;
            }
            return guardCancel(await confirm({
                ...p,
                message: stylePromptMessage(p.message),
            }), params.runtime);
        },
        confirmRuntimeRepair: async (p) => {
            if (shouldAutoApproveDoctorFix(repairMode, { blockDuringUpdate: true })) {
                return true;
            }
            if (repairMode.nonInteractive) {
                return false;
            }
            if (!repairMode.canPrompt) {
                return p.initialValue ?? false;
            }
            return guardCancel(await confirm({
                ...p,
                message: stylePromptMessage(p.message),
            }), params.runtime);
        },
        select: async (p, fallback) => {
            if (!repairMode.canPrompt || repairMode.shouldRepair) {
                return fallback;
            }
            return guardCancel(await select({
                ...p,
                message: stylePromptMessage(p.message),
                options: p.options.map((opt) => opt.hint === undefined ? opt : { ...opt, hint: stylePromptHint(opt.hint) }),
            }), params.runtime);
        },
        shouldRepair: repairMode.shouldRepair,
        shouldForce: repairMode.shouldForce,
        repairMode,
    };
}
