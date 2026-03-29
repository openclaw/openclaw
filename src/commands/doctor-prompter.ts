import { confirm, select } from "@clack/prompts";
import type { RuntimeEnv } from "../runtime.js";
import { stylePromptHint, stylePromptMessage } from "../terminal/prompt-style.js";
import {
  resolveDoctorRepairMode,
  shouldAutoApproveDoctorFix,
  type DoctorRepairMode,
} from "./doctor-repair-mode.js";
import { guardCancel } from "./wizard-core.js";

export type DoctorOptions = {
  workspaceSuggestions?: boolean;
  yes?: boolean;
  nonInteractive?: boolean;
  deep?: boolean;
  repair?: boolean;
  force?: boolean;
  generateGatewayToken?: boolean;
};

export type DoctorPrompter = {
  confirm: (params: Parameters<typeof confirm>[0]) => Promise<boolean>;
  confirmAutoFix: (params: Parameters<typeof confirm>[0]) => Promise<boolean>;
  confirmAggressiveAutoFix: (params: Parameters<typeof confirm>[0]) => Promise<boolean>;
  confirmRuntimeRepair: (params: Parameters<typeof confirm>[0]) => Promise<boolean>;
  select: <T>(params: Parameters<typeof select>[0], fallback: T) => Promise<T>;
  shouldRepair: boolean;
  shouldForce: boolean;
  repairMode: DoctorRepairMode;
};

export function createDoctorPrompter(params: {
  runtime: RuntimeEnv;
  options: DoctorOptions;
}): DoctorPrompter {
  const repairMode = resolveDoctorRepairMode(params.options);
  const confirmDefault = async (p: Parameters<typeof confirm>[0]) => {
    if (shouldAutoApproveDoctorFix(repairMode)) {
      return true;
    }
    if (repairMode.nonInteractive) {
      return false;
    }
    if (!repairMode.canPrompt) {
      return false;
    }
    return guardCancel(
      await confirm({
        ...p,
        message: stylePromptMessage(p.message),
      }),
      params.runtime,
    );
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
        return false;
      }
      return guardCancel(
        await confirm({
          ...p,
          message: stylePromptMessage(p.message),
        }),
        params.runtime,
      );
    },
    confirmRuntimeRepair: async (p) => {
      if (shouldAutoApproveDoctorFix(repairMode, { blockDuringUpdate: true })) {
        return true;
      }
      if (repairMode.nonInteractive) {
        return false;
      }
      if (!repairMode.canPrompt) {
        return false;
      }
      return guardCancel(
        await confirm({
          ...p,
          message: stylePromptMessage(p.message),
        }),
        params.runtime,
      );
    },
    select: async <T>(p: Parameters<typeof select>[0], fallback: T) => {
      if (!repairMode.canPrompt || repairMode.shouldRepair) {
        return fallback;
      }
      return guardCancel(
        await select({
          ...p,
          message: stylePromptMessage(p.message),
          options: p.options.map((opt) =>
            opt.hint === undefined ? opt : { ...opt, hint: stylePromptHint(opt.hint) },
          ),
        }),
        params.runtime,
      ) as T;
    },
    shouldRepair: repairMode.shouldRepair,
    shouldForce: repairMode.shouldForce,
    repairMode,
  };
}
