import { confirm, select } from "@clack/prompts";
import { styleSelectParams } from "../../packages/terminal-core/src/prompt-select-styled-params.js";
import { stylePromptMessage } from "../../packages/terminal-core/src/prompt-style.js";
import { recordDoctorRepairOutcome } from "../infra/update-doctor-result.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveDoctorRepairMode, shouldAutoApproveDoctorFix } from "./doctor-repair-mode.js";
import type { DoctorOptions } from "./doctor.types.js";
import { guardCancel } from "./onboard-helpers.js";

export type { DoctorOptions } from "./doctor.types.js";

type DoctorConfirmParams = Parameters<typeof confirm>[0];
type DoctorRuntimeRepairConfirmParams = DoctorConfirmParams & {
  requiresInteractiveConfirmation?: boolean;
};

export type DoctorPrompter = ReturnType<typeof createDoctorPrompter>;

export function createDoctorPrompter(params: {
  runtime: RuntimeEnv;
  options: DoctorOptions;
  signal?: AbortSignal;
}) {
  const repairMode = resolveDoctorRepairMode(params.options);
  const declineRepair = () => {
    recordDoctorRepairOutcome(undefined);
    return false;
  };
  const confirmPrompt = async (p: DoctorConfirmParams) => {
    if (params.signal?.aborted || repairMode.nonInteractive) {
      return declineRepair();
    }
    if (!repairMode.canPrompt) {
      return p.initialValue === true ? true : declineRepair();
    }
    // Exit 130 (SIGINT convention) so the installer can distinguish
    // user cancellation from normal doctor failures.
    const answer = await confirm({
      ...p,
      signal: params.signal
        ? p.signal
          ? AbortSignal.any([p.signal, params.signal])
          : params.signal
        : p.signal,
      message: stylePromptMessage(p.message),
    });
    // Maintenance interruption declines new consent without abandoning restoration.
    const approved = params.signal?.aborted ? false : guardCancel(answer, params.runtime, 130);
    return approved || declineRepair();
  };
  const confirmDefault = async (p: DoctorConfirmParams) => {
    if (shouldAutoApproveDoctorFix(repairMode)) {
      return true;
    }
    return confirmPrompt(p);
  };

  return {
    confirm: confirmDefault,
    confirmAutoFix: confirmDefault,
    confirmAggressiveAutoFix: async (p: DoctorConfirmParams) => {
      if (shouldAutoApproveDoctorFix(repairMode, { requiresForce: true })) {
        return true;
      }
      if (repairMode.shouldRepair && !repairMode.shouldForce) {
        return declineRepair();
      }
      return confirmPrompt(p);
    },
    confirmRuntimeRepair: async (p: DoctorRuntimeRepairConfirmParams) => {
      const { requiresInteractiveConfirmation, ...confirmParams } = p;
      if (
        requiresInteractiveConfirmation !== true &&
        shouldAutoApproveDoctorFix(repairMode, { blockDuringUpdate: true })
      ) {
        return true;
      }
      if (requiresInteractiveConfirmation === true && !repairMode.canPrompt) {
        return declineRepair();
      }
      return confirmPrompt(confirmParams);
    },
    select: async <T>(p: Parameters<typeof select>[0], fallback: T) => {
      if (!repairMode.canPrompt || repairMode.shouldRepair) {
        return fallback;
      }
      return guardCancel(await select(styleSelectParams(p)), params.runtime, 130) as T;
    },
    shouldRepair: repairMode.shouldRepair,
    shouldForce: repairMode.shouldForce,
    repairMode,
  };
}
